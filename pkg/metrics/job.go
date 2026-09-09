package metrics

import (
	"time"
)

// Job is the normalized view of a workflow job that the reports aggregate over.
type Job struct {
	RunID       int64
	Kind        JobKind
	RunnerID    int64
	RunnerName  string
	RunnerGroup string
	Labels      []string
	Workflow    string
	Name        string
	Conclusion  string
	QueuedAt    time.Time
	StartedAt   time.Time
	CompletedAt time.Time
}

// Job conclusions the reports treat specially.
const (
	conclusionSuccess  = "success"
	conclusionFailure  = "failure"
	conclusionTimedOut = "timed_out"
	conclusionSkipped  = "skipped"
)

// NewJobs normalizes the raw jobs of data, dropping the ones that never occupied a
// runner: jobs that were skipped and jobs that have not finished yet.
func NewJobs(data *Data) []Job {
	runnerIDs := data.SelfHostedRunnerIDs()

	jobs := make([]Job, 0, len(data.Jobs))
	for _, raw := range data.Jobs {
		if raw.GetConclusion() == conclusionSkipped {
			continue
		}

		// Check runs published by apps share the check suite of the workflow run, so the
		// jobs API returns them too. They carry no runs-on labels, which every real job
		// has, and their start and completion timestamps are identical.
		if len(raw.Labels) == 0 {
			continue
		}

		started := raw.GetStartedAt().Time
		completed := raw.GetCompletedAt().Time
		if started.IsZero() || completed.IsZero() {
			continue
		}

		jobs = append(jobs, Job{
			RunID:       raw.GetRunID(),
			Kind:        ClassifyJob(raw, runnerIDs),
			RunnerID:    raw.GetRunnerID(),
			RunnerName:  raw.GetRunnerName(),
			RunnerGroup: raw.GetRunnerGroupName(),
			Labels:      raw.Labels,
			Workflow:    raw.GetWorkflowName(),
			Name:        raw.GetName(),
			Conclusion:  raw.GetConclusion(),
			QueuedAt:    raw.GetCreatedAt().Time,
			StartedAt:   started,
			CompletedAt: completed,
		})
	}
	return jobs
}

// FleetJobs keeps the jobs that did not run on a GitHub-hosted runner.
// Jobs whose runner could not be identified are kept, because a job that ran on a
// self-hosted runner which has since been deregistered is still fleet activity.
func FleetJobs(jobs []Job) []Job {
	fleet := make([]Job, 0, len(jobs))
	for _, job := range jobs {
		if job.Kind != JobKindHosted {
			fleet = append(fleet, job)
		}
	}
	return fleet
}

// Wait is how long the job sat between being created and being picked up.
// It also covers the time spent waiting on needs dependencies and on concurrency
// groups, so it is an upper bound on the pure runner queue time.
func (j Job) Wait() time.Duration {
	return nonNegative(j.StartedAt.Sub(j.QueuedAt))
}

// Duration is how long the job occupied a runner.
func (j Job) Duration() time.Duration {
	return nonNegative(j.CompletedAt.Sub(j.StartedAt))
}

// Interval is the span during which the job kept a runner busy.
func (j Job) Interval() Interval {
	return Interval{Start: j.StartedAt, End: j.CompletedAt}
}

// Failed reports whether the job ended in a way the owner should look at.
func (j Job) Failed() bool {
	return j.Conclusion == conclusionFailure || j.Conclusion == conclusionTimedOut
}

// Decided reports whether the job produced a pass or fail outcome. Cancelled jobs are
// excluded so that a cancelled pipeline does not look like a broken one.
func (j Job) Decided() bool {
	return j.Failed() || j.Conclusion == conclusionSuccess
}

// jobStats are the shared aggregates every report row is built from.
type jobStats struct {
	count     int
	waits     []time.Duration
	durations []time.Duration
	intervals []Interval
	busy      time.Duration
	decided   int
	failed    int
	lastJobAt time.Time
}

// add folds job into the aggregate, counting only the busy time that falls inside w.
func (s *jobStats) add(job Job, w Window) {
	s.count++
	s.waits = append(s.waits, job.Wait())
	s.durations = append(s.durations, job.Duration())

	if iv, ok := w.Clamp(job.Interval()); ok {
		s.intervals = append(s.intervals, iv)
		s.busy += iv.Duration()
	}
	if job.Decided() {
		s.decided++
	}
	if job.Failed() {
		s.failed++
	}
	if job.CompletedAt.After(s.lastJobAt) {
		s.lastJobAt = job.CompletedAt
	}
}

// failureRate is the share of decided jobs that failed.
func (s *jobStats) failureRate() float64 {
	if s.decided == 0 {
		return 0
	}
	return float64(s.failed) / float64(s.decided)
}

func nonNegative(d time.Duration) time.Duration {
	return max(d, 0)
}
