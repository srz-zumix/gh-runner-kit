package metrics

import (
	"cmp"
	"slices"
	"strings"
	"time"
)

// QueueRow is one line of the metrics queue report: how one runs-on label set fared.
type QueueRow struct {
	Labels          []string
	Kind            JobKind
	Jobs            int
	WaitP50         time.Duration
	WaitP95         time.Duration
	WaitMax         time.Duration
	Runners         int
	PeakConcurrency int
	Saturation      float64
}

// LabelSet renders the label set as it would be written in runs-on.
func (r QueueRow) LabelSet() string {
	return strings.Join(r.Labels, ",")
}

// BuildQueueStats groups the fleet jobs by their runs-on label set and measures how
// long each set waited relative to the number of runners that can serve it.
func BuildQueueStats(data *Data) []QueueRow {
	type bucket struct {
		labels []string
		kind   JobKind
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
			b = &bucket{labels: labels, kind: job.Kind}
			buckets[key] = b
		}
		b.stats.add(job, data.Window)
	}

	rows := make([]QueueRow, 0, len(buckets))
	for _, b := range buckets {
		row := QueueRow{
			Labels:          b.labels,
			Kind:            b.kind,
			Jobs:            b.stats.count,
			WaitP50:         Percentile(b.stats.waits, 50),
			WaitP95:         Percentile(b.stats.waits, 95),
			WaitMax:         Percentile(b.stats.waits, 100),
			Runners:         countMatchingRunners(data, b.labels),
			PeakConcurrency: PeakConcurrency(b.stats.intervals),
		}
		// Saturation above 1 means the label set demanded more runners at once than it
		// has, which is the signal that adding capacity would cut the wait time.
		if row.Runners > 0 {
			row.Saturation = float64(row.PeakConcurrency) / float64(row.Runners)
		}
		rows = append(rows, row)
	}

	slices.SortFunc(rows, func(a, b QueueRow) int {
		if c := cmp.Compare(b.WaitP95, a.WaitP95); c != 0 {
			return c
		}
		return cmp.Compare(a.LabelSet(), b.LabelSet())
	})
	return rows
}

// countMatchingRunners counts the registered runners that carry every requested label.
func countMatchingRunners(data *Data, labels []string) int {
	count := 0
	for _, runner := range data.Runners {
		runnerLabels := make([]string, 0, len(runner.Labels))
		for _, label := range runner.Labels {
			runnerLabels = append(runnerLabels, label.GetName())
		}
		if MatchesRunner(labels, runnerLabels) {
			count++
		}
	}
	return count
}
