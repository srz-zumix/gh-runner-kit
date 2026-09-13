package metrics

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
)

// CapacityRow is one line of the metrics capacity report: how many runners one runs-on
// label set would need to meet the target queue time.
type CapacityRow struct {
	Labels []string
	Jobs   int
	// ArrivalPerHour is how many jobs of this set were created per hour of the window.
	ArrivalPerHour float64
	// AvgDuration is the mean time a job of this set occupied a runner.
	AvgDuration time.Duration
	// Load is the offered load in Erlangs: the number of runners the set kept busy on
	// average across the window.
	Load        float64
	Runners     int
	Recommended int
	// Delta is how many runners have to be added, or removed when negative.
	Delta int
	// ObservedWaitP95 is what the jobs actually waited, for comparison with the model.
	ObservedWaitP95 time.Duration
	// EstimatedWait is the mean queue time the model predicts for Recommended runners.
	EstimatedWait time.Duration
	// EstimatedWaitKnown is false when the recommended pool cannot keep up with the load,
	// so no finite mean queue time exists and EstimatedWait must not be read as zero.
	EstimatedWaitKnown bool
	// TargetMet is false when even the capped recommendation cannot satisfy the target
	// wait and utilization, so Recommended is a lower bound rather than a verified size.
	TargetMet bool
}

// LabelSet renders the label set as it would be written in runs-on.
func (r CapacityRow) LabelSet() string {
	return strings.Join(r.Labels, ",")
}

// ValidateCapacityTargets rejects the target values the model cannot work with.
func ValidateCapacityTargets(targetWait time.Duration, targetUtilization float64) error {
	if targetWait <= 0 {
		return fmt.Errorf("the target wait must be greater than 0, got %s", targetWait)
	}
	// NaN slips through the range comparisons below because every ordered comparison with
	// NaN is false, and an infinite ratio is equally unusable, so both are rejected first.
	if math.IsNaN(targetUtilization) || math.IsInf(targetUtilization, 0) {
		return fmt.Errorf("the target utilization must be a finite number, got %g", targetUtilization)
	}
	if targetUtilization <= 0 || targetUtilization > 1 {
		return fmt.Errorf("the target utilization must be greater than 0 and at most 1, got %g", targetUtilization)
	}
	return nil
}

// BuildCapacityStats sizes every runs-on label set against the target queue time.
// It models each set as an M/M/c queue, which assumes jobs arrive independently and
// that any runner of the pool can serve any of its jobs, so the recommendation is a
// starting point rather than an exact answer.
func BuildCapacityStats(data *Data, targetWait time.Duration, targetUtilization float64) []CapacityRow {
	type bucket struct {
		labels []string
		stats  jobStats
	}

	buckets := map[string]*bucket{}
	for _, job := range FleetJobs(NewJobs(data)) {
		labels := NormalizeLabelSet(job.Labels)
		key := strings.Join(labels, ",")
		if key == "" {
			key = unknownKey
		}

		b, ok := buckets[key]
		if !ok {
			b = &bucket{labels: labels}
			buckets[key] = b
		}
		b.stats.add(job, data.Window)
	}

	window := data.Window.Duration()
	rows := make([]CapacityRow, 0, len(buckets))
	for _, b := range buckets {
		// The offered load is the busy time the set produced per unit of window time,
		// which is exactly the arrival rate multiplied by the mean service time.
		load := 0.0
		if window > 0 {
			load = float64(b.stats.busy) / float64(window)
		}

		row := CapacityRow{
			Labels:          b.labels,
			Jobs:            b.stats.count,
			ArrivalPerHour:  ratePerHour(b.stats.count, window),
			AvgDuration:     meanDuration(b.stats.durations),
			Load:            load,
			Runners:         countMatchingRunners(data, b.labels),
			ObservedWaitP95: Percentile(b.stats.waits, 95),
		}
		row.Recommended, row.TargetMet = RequiredRunners(load, row.AvgDuration, targetWait, targetUtilization)
		row.Delta = row.Recommended - row.Runners
		row.EstimatedWait, row.EstimatedWaitKnown = ErlangWait(row.Recommended, load, row.AvgDuration)

		rows = append(rows, row)
	}

	// The pools that are short of runners come first, because they are the ones to act on.
	slices.SortFunc(rows, func(a, b CapacityRow) int {
		if c := cmp.Compare(b.Delta, a.Delta); c != 0 {
			return c
		}
		return cmp.Compare(a.LabelSet(), b.LabelSet())
	})
	return rows
}

func ratePerHour(count int, window time.Duration) float64 {
	if window <= 0 {
		return 0
	}
	return float64(count) / window.Hours()
}

func meanDuration(durations []time.Duration) time.Duration {
	if len(durations) == 0 {
		return 0
	}

	var total time.Duration
	for _, d := range durations {
		total += d
	}
	return total / time.Duration(len(durations))
}
