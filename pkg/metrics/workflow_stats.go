package metrics

import (
	"cmp"
	"slices"
	"time"
)

// WorkflowRow is one line of the metrics workflow report.
type WorkflowRow struct {
	Workflow    string
	Runs        int
	Jobs        int
	FailureRate float64
	RetryRate   float64
	WaitP50     time.Duration
	DurationP50 time.Duration
	DurationP95 time.Duration
	BusyTime    time.Duration
	LastJobAt   time.Time
}

// BuildWorkflowStats aggregates the jobs per workflow. selfHostedOnly drops the jobs
// that ran on GitHub-hosted runners, which the other reports always do; this report
// keeps them by default so that a workflow can be judged as a whole.
func BuildWorkflowStats(data *Data, selfHostedOnly bool) []WorkflowRow {
	jobs := NewJobs(data)
	if selfHostedOnly {
		jobs = FleetJobs(jobs)
	}

	attempts := map[int64]int{}
	for _, run := range data.Runs {
		attempts[run.GetID()] = run.GetRunAttempt()
	}

	stats := map[string]*jobStats{}
	runIDs := map[string]map[int64]bool{}
	for _, job := range jobs {
		key := job.Workflow
		if key == "" {
			key = unknownKey
		}

		s, ok := stats[key]
		if !ok {
			s = &jobStats{}
			stats[key] = s
			runIDs[key] = map[int64]bool{}
		}
		s.add(job, data.Window)
		runIDs[key][job.RunID] = true
	}

	rows := make([]WorkflowRow, 0, len(stats))
	for key, s := range stats {
		row := WorkflowRow{
			Workflow:    key,
			Runs:        len(runIDs[key]),
			Jobs:        s.count,
			FailureRate: s.failureRate(),
			WaitP50:     Percentile(s.waits, 50),
			DurationP50: Percentile(s.durations, 50),
			DurationP95: Percentile(s.durations, 95),
			BusyTime:    s.busy,
			LastJobAt:   s.lastJobAt,
		}

		// An attempt above 1 means the run was restarted. It is the only retry signal
		// the API exposes, because the job list of a run only covers its last attempt.
		retried := 0
		for runID := range runIDs[key] {
			if attempts[runID] > 1 {
				retried++
			}
		}
		if row.Runs > 0 {
			row.RetryRate = float64(retried) / float64(row.Runs)
		}
		rows = append(rows, row)
	}

	slices.SortFunc(rows, func(a, b WorkflowRow) int {
		if c := cmp.Compare(b.Jobs, a.Jobs); c != 0 {
			return c
		}
		return cmp.Compare(a.Workflow, b.Workflow)
	})
	return rows
}
