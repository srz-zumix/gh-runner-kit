package metrics

import (
	"cmp"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"
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
	// Billable is the time GitHub charges for, which is rounded up per job on its side.
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
		if price < 0 {
			return nil, fmt.Errorf("invalid rate %q, the price cannot be negative", override)
		}
		rates[name] = price
	}
	return rates, nil
}

// BuildCostStats turns the billable usage of the collected runs into one row per
// operating system. GitHub only bills the jobs it hosted, so self-hosted jobs contribute
// nothing and the totals describe what moving them off the hosted runners already saves.
func BuildCostStats(data *Data, rates map[string]float64) []CostRow {
	type bucket struct {
		runs     int
		jobs     int
		billable time.Duration
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

			b, ok := buckets[os]
			if !ok {
				b = &bucket{}
				buckets[os] = b
			}
			b.runs++
			b.jobs += bill.GetJobs()
			b.billable += time.Duration(bill.GetTotalMS()) * time.Millisecond
		}
	}

	rows := make([]CostRow, 0, len(buckets))
	for os, b := range buckets {
		rate := rates[os]
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
	return rows
}
