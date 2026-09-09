package metrics

import "time"

// DefaultBucket is the width of a concurrency bucket when --bucket is not given.
const DefaultBucket = time.Hour

// ConcurrencyRow is one line of the metrics concurrency report: a single time bucket.
type ConcurrencyRow struct {
	Start       time.Time
	End         time.Time
	Jobs        int
	Peak        int
	BusyTime    time.Duration
	Runners     int
	Utilization float64
}

// BuildConcurrencyStats reconstructs how many fleet jobs ran at the same time over the
// window, one fixed-width bucket at a time, and compares that against the number of
// runners able to serve them. labels keeps only the jobs that requested every one of
// them, and narrows the runner count the same way.
func BuildConcurrencyStats(data *Data, bucket time.Duration, labels []string) []ConcurrencyRow {
	filter := NormalizeLabelSet(labels)

	intervals := make([]Interval, 0, len(data.Jobs))
	for _, job := range FleetJobs(NewJobs(data)) {
		// A job passes the filter when its runs-on set carries every requested label,
		// which is the same subset test a runner has to satisfy to pick the job up.
		if len(filter) > 0 && !MatchesRunner(filter, job.Labels) {
			continue
		}
		intervals = append(intervals, job.Interval())
	}

	runners := len(data.Runners)
	if len(filter) > 0 {
		runners = countMatchingRunners(data, filter)
	}

	timeline := ConcurrencyTimeline(intervals, data.Window, bucket)
	rows := make([]ConcurrencyRow, 0, len(timeline))
	for _, b := range timeline {
		rows = append(rows, ConcurrencyRow{
			Start:       b.Start,
			End:         b.End,
			Jobs:        b.Jobs,
			Peak:        b.Peak,
			BusyTime:    b.Busy,
			Runners:     runners,
			Utilization: Utilization(b.Busy, b.Duration()*time.Duration(runners)),
		})
	}
	return rows
}
