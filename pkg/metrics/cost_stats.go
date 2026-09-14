package metrics

import (
	"cmp"
	"fmt"
	"maps"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/go-github/v90/github"
)

// DefaultRates lists the per-minute price in USD that GitHub charges for its standard
// two core hosted runners, keyed by the operating system name the usage API reports.
// Larger runners cost more, so override them with --rate when the fleet uses them.
var DefaultRates = map[string]float64{
	"UBUNTU":  0.008,
	"WINDOWS": 0.016,
	"MACOS":   0.08,
}

// CostRow is one line of the metrics cost report: the billable time of one operating
// system across the window.
type CostRow struct {
	OS   string
	Runs int
	Jobs int
	// Billable is the estimated time GitHub charges for, rounded up per job when the
	// usage API provides individual job durations.
	Billable time.Duration
	// Rate is the per-minute price applied to Billable.
	Rate float64
	Cost float64
}

// CostTotal sums the billable time and the estimated cost of every row.
func CostTotal(rows []CostRow) (time.Duration, float64) {
	var (
		billable time.Duration
		cost     float64
	)
	for _, row := range rows {
		billable += row.Billable
		cost += row.Cost
	}
	return billable, cost
}

// ParseRates applies OS=PRICE overrides on top of DefaultRates. The operating system is
// matched case-insensitively, so both ubuntu and UBUNTU select the Linux rate.
func ParseRates(overrides []string) (map[string]float64, error) {
	rates := maps.Clone(DefaultRates)

	for _, override := range overrides {
		name, value, found := strings.Cut(override, "=")
		if !found {
			return nil, fmt.Errorf("invalid rate %q, expected the OS=PRICE format such as ubuntu=0.008", override)
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

// BuildCostStats turns the billable usage of the collected runs into one row per
// operating system. GitHub only bills the jobs it hosted, so self-hosted jobs contribute
// nothing and the totals describe both the current hosted spend and what moving the same
// work to self-hosted runners would avoid. It also returns one warning per operating
// system that has billable time but no known per-minute rate, because such a row is
// estimated at $0 and would otherwise understate the total silently. When the API omits
// per-job durations, it falls back to the aggregate duration and warns that the result
// cannot include GitHub's per-job minute rounding.
func BuildCostStats(data *Data, rates map[string]float64) ([]CostRow, []string) {
	type bucket struct {
		runs          int
		jobs          int
		billable      time.Duration
		unroundedRuns int
	}

	buckets := map[string]*bucket{}
	for _, usage := range data.Usage {
		if usage == nil || usage.Billable == nil {
			continue
		}

		for os, bill := range *usage.Billable {
			if bill == nil {
				continue
			}
			jobs := bill.GetJobs()
			totalMS := bill.GetTotalMS()
			jobRuns := bill.GetJobRuns()
			if jobs <= 0 && totalMS <= 0 {
				continue
			}

			b, ok := buckets[os]
			if !ok {
				b = &bucket{}
				buckets[os] = b
			}
			b.runs++
			b.jobs += jobs
			if rounded, ok := roundedJobRunsDuration(jobRuns, jobs, totalMS); ok {
				if jobs <= 0 {
					b.jobs += len(jobRuns)
				}
				b.billable += rounded
			} else {
				b.billable += time.Duration(totalMS) * time.Millisecond
				b.unroundedRuns++
			}
		}
	}

	rows := make([]CostRow, 0, len(buckets))
	var warnings []string
	if len(data.Runs) > len(data.Usage) {
		warnings = append(warnings, fmt.Sprintf(
			"cost estimate is partial: usage was available for %d of %d workflow runs",
			len(data.Usage), len(data.Runs),
		))
	}
	for os, b := range buckets {
		rate, known := rates[os]
		if !known && b.billable > 0 {
			warnings = append(warnings, fmt.Sprintf("no per-minute rate for %q, its billable time is estimated at $0.00; pass --rate %s=PRICE to price it", os, strings.ToLower(os)))
		}
		if b.unroundedRuns > 0 {
			warnings = append(warnings, fmt.Sprintf(
				"%q usage omitted per-job durations for %d run(s); aggregate time was used without per-job minute rounding and may understate the cost",
				os, b.unroundedRuns,
			))
		}
		rows = append(rows, CostRow{
			OS:       os,
			Runs:     b.runs,
			Jobs:     b.jobs,
			Billable: b.billable,
			Rate:     rate,
			Cost:     b.billable.Minutes() * rate,
		})
	}

	// The most expensive operating system comes first, because it is the one to move.
	slices.SortFunc(rows, func(a, b CostRow) int {
		if c := cmp.Compare(b.Cost, a.Cost); c != 0 {
			return c
		}
		return cmp.Compare(a.OS, b.OS)
	})
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
		if jobRun == nil || jobRun.DurationMS == nil {
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
