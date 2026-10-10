package metrics

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/go-github/v90/github"
)

// DefaultRates lists standard x64 runner prices for callers displaying reference rates.
// Automatic pricing uses the billing SKU catalog, not these OS-wide reference values.
var DefaultRates = map[string]float64{
	"UBUNTU":  hostedPrices.Rates["actions_linux"],
	"WINDOWS": hostedPrices.Rates["actions_windows"],
	"MACOS":   hostedPrices.Rates["actions_macos"],
}

// CostRow groups execution by billing SKU, machine specification and applied rate.
type CostRow struct {
	OS   string
	Runs int
	Jobs int
	// Billable is the estimated time GitHub charges for, rounded up per job when the
	// usage API provides individual job durations.
	Billable time.Duration
	// Rate is the per-minute price applied to Billable.
	Rate         *float64
	Cost         *float64
	KnownCost    float64
	UnpricedJobs int
	RunnerClass  string
	SKU          string
	Architecture string
	CPUCores     int
	MemoryGB     int
	StorageGB    int
	Larger       bool
	Source       string
	Reason       string
	PriceVersion string
}

// CostTotal sums the billable time and the estimated cost of every row.
func CostTotal(rows []CostRow) (time.Duration, *float64) {
	var (
		billable time.Duration
		cost     float64
		known    = true
	)
	for _, row := range rows {
		billable += row.Billable
		if row.Cost == nil {
			known = false
		} else {
			cost += *row.Cost
		}
	}
	if !known {
		return billable, nil
	}
	return billable, &cost
}

// ParseRates validates explicit OS=PRICE or SKU=PRICE overrides. Empty means automatic pricing.
func ParseRates(overrides []string) (map[string]float64, error) {
	rates := map[string]float64{}

	for _, override := range overrides {
		name, value, found := strings.Cut(override, "=")
		if !found {
			return nil, fmt.Errorf("invalid rate %q, expected the OS=PRICE or SKU=PRICE format such as linux_8_core=0.022", override)
		}

		name = strings.ToUpper(strings.TrimSpace(name))
		if name == "" {
			return nil, fmt.Errorf("invalid rate %q, the OS name is empty", override)
		}

		price, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
		if err != nil {
			return nil, fmt.Errorf("invalid rate %q: %w", override, err)
		}
		// ParseFloat accepts NaN and infinities, which would poison Cost, so only a
		// finite, non-negative price is stored.
		if math.IsNaN(price) || math.IsInf(price, 0) {
			return nil, fmt.Errorf("invalid rate %q, the price must be a finite number", override)
		}
		if price < 0 {
			return nil, fmt.Errorf("invalid rate %q, the price cannot be negative", override)
		}
		rates[name] = price
	}
	return rates, nil
}

type billedJob struct {
	os           string
	milliseconds int64
}

func jobUsageDurations(data *Data) map[int64]billedJob {
	billed := map[int64]billedJob{}
	for _, usage := range data.Usage {
		if usage == nil || usage.Billable == nil {
			continue
		}
		for os, bill := range *usage.Billable {
			for _, job := range bill.GetJobRuns() {
				if job != nil && job.DurationMS != nil && job.GetDurationMS() >= 0 {
					billed[int64(job.GetJobID())] = billedJob{os, job.GetDurationMS()}
				}
			}
		}
	}
	return billed
}

// BuildCostStats prices hosted jobs using their labels and current pool specifications.
// Usage durations take precedence over timestamps. Unmatched usage remains explicitly unpriced.
func BuildCostStats(data *Data, rates map[string]float64) ([]CostRow, []string) {
	type bucket struct {
		row  CostRow
		runs map[int64]bool
	}
	billed := jobUsageDurations(data)
	buckets := map[string]*bucket{}
	var warnings []string
	add := func(runID int64, jobs int, duration time.Duration, price HostedPrice) {
		rateKey := "unknown"
		if price.Rate != nil {
			rateKey = strconv.FormatFloat(*price.Rate, 'g', -1, 64)
		}
		key := fmt.Sprintf("%s/%s/%d/%d/%d/%s/%s/%s/%s", price.OS, price.SKU, price.CPUCores, price.MemoryGB, price.StorageGB, price.Architecture, rateKey, price.Source, price.Reason)
		b := buckets[key]
		if b == nil {
			b = &bucket{runs: map[int64]bool{}, row: CostRow{OS: price.OS, Rate: price.Rate, Cost: github.Ptr(0.0), RunnerClass: price.RunnerClass, SKU: price.SKU, Architecture: price.Architecture, CPUCores: price.CPUCores, MemoryGB: price.MemoryGB, StorageGB: price.StorageGB, Larger: price.Larger, Source: price.Source, Reason: price.Reason, PriceVersion: hostedPrices.Version}}
			buckets[key] = b
		}
		b.runs[runID] = true
		b.row.Jobs += jobs
		b.row.Billable += duration
		if price.Rate == nil {
			b.row.UnpricedJobs += jobs
			b.row.Cost = nil
		} else {
			b.row.KnownCost += duration.Minutes() * *price.Rate
			if b.row.Cost != nil {
				*b.row.Cost = b.row.KnownCost
			}
		}
	}
	seen := map[int64]bool{}
	runsWithJobs := map[int64]bool{}
	runsWithAnyJobs := map[int64]bool{}
	pricedRecords := map[int64]int{}
	ids := data.SelfHostedRunnerIDs()
	for _, job := range data.Jobs {
		if job == nil {
			continue
		}
		if job.GetID() != 0 && seen[job.GetID()] {
			continue
		}
		runID := job.GetRunID()
		runsWithAnyJobs[runID] = true
		detail, reported := billed[job.GetID()]
		if job.GetConclusion() == conclusionSkipped ||
			(job.GetConclusion() == conclusionCancelled && !jobExecutionStarted(job) && (!reported || detail.milliseconds == 0)) {
			seen[job.GetID()] = true
			continue
		}
		repo := data.RunRepositories[runID]
		var public *bool
		if value, ok := data.RepositoryPublic[repo]; ok {
			public = &value
		}
		owner, _, _ := strings.Cut(repo, "/")
		price := PriceHostedJob(job, data.HostedRunners[strings.ToLower(owner)], ids, public, rates)
		if price.Excluded {
			seen[job.GetID()] = true
			continue
		}
		start, end := job.GetStartedAt().Time, job.GetCompletedAt().Time
		duration := end.Sub(start)
		if reported {
			duration = time.Duration(detail.milliseconds) * time.Millisecond
			if price.OS == "UNKNOWN" {
				price.OS, price.RunnerClass, price.Source = detail.os, detail.os+" (unknown hardware)", "usage API"
				if rate, ok := rates[detail.os]; ok {
					price.Rate, price.Reason, price.Source = &rate, "", "OS override"
				}
			}
		} else if start.IsZero() || end.IsZero() || duration < 0 {
			if job.GetStatus() == "completed" && jobExecutionStarted(job) {
				price.Rate, price.Reason = nil, "completed execution duration is unavailable"
				add(runID, 1, 0, price)
				seen[job.GetID()] = true
				runsWithJobs[runID] = true
				pricedRecords[runID]++
			}
			continue
		}
		duration = roundedBillableDuration(duration.Milliseconds())
		if strings.HasPrefix(price.SKU, "actions_") && public != nil && *public {
			duration = 0
		}
		add(runID, 1, duration, price)
		seen[job.GetID()], runsWithJobs[runID] = true, true
		pricedRecords[runID]++
	}
	for _, run := range data.Runs {
		if run == nil || run.GetStatus() != "completed" || runsWithAnyJobs[run.GetID()] {
			continue
		}
		usage := data.Usage[run.GetID()]
		if usage == nil || usage.Billable == nil {
			add(run.GetID(), 0, 0, HostedPrice{
				OS: "UNKNOWN", RunnerClass: "Unknown collection", Source: "collection coverage",
				Reason: "completed run has neither job records nor billable usage",
			})
		}
	}
	for runID, usage := range data.Usage {
		if usage == nil || usage.Billable == nil {
			continue
		}
		reportedJobs, incomplete := 0, false
		for os, bill := range *usage.Billable {
			if bill == nil || (bill.GetJobs() <= 0 && bill.GetTotalMS() <= 0) {
				continue
			}
			reportedJobs += bill.GetJobs()
			price := HostedPrice{OS: os, RunnerClass: os + " (unknown hardware)", Source: "usage API", Reason: "usage has no matching job hardware"}
			if rate, ok := rates[os]; ok {
				price.Rate, price.Reason, price.Source = &rate, "", "OS override"
			}
			if _, complete := roundedJobRunsDuration(bill.GetJobRuns(), bill.GetJobs(), bill.GetTotalMS()); complete {
				for _, job := range bill.GetJobRuns() {
					if !seen[int64(job.GetJobID())] {
						add(runID, 1, roundedBillableDuration(job.GetDurationMS()), price)
						pricedRecords[runID]++
					}
				}
			} else if !runsWithJobs[runID] {
				add(runID, bill.GetJobs(), time.Duration(bill.GetTotalMS())*time.Millisecond, price)
				warnings = append(warnings, fmt.Sprintf("%q usage omitted per-job durations; aggregate time was used without per-job minute rounding", os))
			} else {
				incomplete = true
			}
		}
		if incomplete && reportedJobs > pricedRecords[runID] {
			add(runID, reportedJobs-pricedRecords[runID], 0, HostedPrice{
				OS: "UNKNOWN", RunnerClass: "Unknown collection", Source: "collection coverage",
				Reason: "usage includes additional jobs or attempts without complete job metadata or durations",
			})
		}
	}
	if len(data.Runs) > len(data.Usage) {
		warnings = append(warnings, fmt.Sprintf(
			"usage was available for %d of %d workflow runs; other prices use completed job timestamps",
			len(data.Usage), len(data.Runs),
		))
	}
	rows := make([]CostRow, 0, len(buckets))
	for _, b := range buckets {
		b.row.Runs = len(b.runs)
		if b.row.Cost == nil {
			if b.row.UnpricedJobs == 0 {
				warnings = append(warnings, fmt.Sprintf("cost coverage is unavailable for %d run(s): %s", b.row.Runs, b.row.Reason))
			} else {
				warnings = append(warnings, fmt.Sprintf("%s: %d job(s) have unknown prices: %s", b.row.RunnerClass, b.row.UnpricedJobs, b.row.Reason))
			}
		}
		rows = append(rows, b.row)
	}
	slices.SortFunc(rows, func(a, b CostRow) int {
		if c := cmp.Compare(b.KnownCost, a.KnownCost); c != 0 {
			return c
		}
		return cmp.Compare(a.RunnerClass, b.RunnerClass)
	})
	slices.Sort(warnings)
	return rows, warnings
}

func roundedJobRunsDuration(jobRuns []*github.WorkflowRunJobRun, jobs int, totalMS int64) (time.Duration, bool) {
	if len(jobRuns) == 0 || (jobs > 0 && len(jobRuns) != jobs) {
		return 0, false
	}

	var (
		rawMS   int64
		rounded time.Duration
	)
	for _, jobRun := range jobRuns {
		if jobRun == nil || jobRun.DurationMS == nil || jobRun.GetDurationMS() < 0 {
			return 0, false
		}
		rawMS += jobRun.GetDurationMS()
		rounded += roundedBillableDuration(jobRun.GetDurationMS())
	}
	if totalMS > 0 && rawMS == 0 {
		return 0, false
	}
	return rounded, true
}

func roundedBillableDuration(milliseconds int64) time.Duration {
	if milliseconds <= 0 {
		return 0
	}
	minutes := milliseconds / int64(time.Minute/time.Millisecond)
	if milliseconds%int64(time.Minute/time.Millisecond) != 0 {
		minutes++
	}
	return time.Duration(minutes) * time.Minute
}
