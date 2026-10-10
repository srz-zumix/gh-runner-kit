package metrics

import (
	"cmp"
	"slices"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

// RunTimeline lays out the jobs of one workflow run attempt and their steps on a common
// time axis, the way a Gantt chart of the run shows them.
type RunTimeline struct {
	Repo         string
	RunID        int64
	RunAttempt   int64
	Workflow     string
	WorkflowPath string
	Event        string
	Branch       string
	HeadSHA      string
	URL          string
	Status       string
	Conclusion   string
	// StartedAt is the origin of the time axis: the instant the attempt started, or the
	// instant its first job was queued when that came earlier or the start is unknown.
	StartedAt *time.Time
	// CompletedAt is the instant the last job of the attempt finished, or unset when no
	// job has finished.
	CompletedAt *time.Time
	// Duration spans StartedAt to CompletedAt.
	Duration time.Duration
	Jobs     []TimelineJob
}

// TimelineJob is one job of a RunTimeline.
type TimelineJob struct {
	JobID       int64
	Name        string
	URL         string
	Labels      []string
	Kind        JobKind
	RunnerID    int64
	RunnerName  string
	RunnerGroup string
	Status      string
	Conclusion  string
	QueuedAt    *time.Time
	StartedAt   *time.Time
	CompletedAt *time.Time
	// Wait is how long the job waited for a runner.
	Wait     time.Duration
	Duration time.Duration
	// QueuedOffset and StartedOffset place the job on the run's time axis. They are 0
	// when the corresponding timestamp is unknown.
	QueuedOffset  time.Duration
	StartedOffset time.Duration
	Steps         []TimelineStep
}

// TimelineStep is one step of a TimelineJob.
type TimelineStep struct {
	Number int64
	Name   string
	Key    string
	// Occurrence is N for the Nth step of the job named Name, starting at 1.
	Occurrence  int
	Status      string
	Conclusion  string
	StartedAt   *time.Time
	CompletedAt *time.Time
	Duration    time.Duration
	// Offset places the step on the run's time axis, and JobOffset inside its job. Both
	// are 0 when the step never started.
	Offset    time.Duration
	JobOffset time.Duration
}

// TimelineOptions narrows which jobs a RunTimeline keeps.
type TimelineOptions struct {
	// Jobs keeps the jobs whose name matches any of these patterns, which accept the
	// wildcard MatchWildcard does.
	Jobs []string
	// JobID keeps only the job with this ID when it is not 0.
	JobID int64
}

// Validate reports whether the options can be applied.
func (o TimelineOptions) Validate() error {
	return validateNamePatterns("--job", o.Jobs)
}

func (o TimelineOptions) match(job JobRow) bool {
	if o.JobID != 0 && job.JobID != o.JobID {
		return false
	}
	return len(o.Jobs) == 0 || matchesAnyNamePattern(o.Jobs, job.JobName)
}

// BuildRunTimeline lays out the jobs of run, which describes one attempt, on a time axis
// that starts when the attempt started. Jobs reported for another attempt are dropped,
// so that a job an earlier attempt ran does not stretch the axis back in time. The jobs
// are ordered by the instant they started, and their steps by step number.
func BuildRunTimeline(repo repository.Repository, run *github.WorkflowRun, jobs []*github.WorkflowJob, opts TimelineOptions) RunTimeline {
	runID := run.GetID()
	attempt := int64(run.GetRunAttempt())
	data := &Data{
		Runs:            []*github.WorkflowRun{run},
		Jobs:            jobs,
		RunRepositories: map[int64]string{runID: repo.Owner + "/" + repo.Name},
	}
	b := newJobRowBuilder(data, JobRowOptions{})

	type jobEntry struct {
		row JobRow
		raw *github.WorkflowJob
	}
	entries := make([]jobEntry, 0, len(jobs))
	for _, raw := range jobs {
		if raw == nil || (attempt > 0 && raw.GetRunAttempt() != 0 && raw.GetRunAttempt() != attempt) {
			continue
		}
		row, ok := b.build(raw)
		if !ok || !opts.match(row) {
			continue
		}
		entries = append(entries, jobEntry{row: row, raw: raw})
	}
	slices.SortFunc(entries, func(a, b jobEntry) int {
		if c := compareOptionalTime(a.row.StartedAt, b.row.StartedAt); c != 0 {
			return c
		}
		if c := compareOptionalTime(a.row.QueuedAt, b.row.QueuedAt); c != 0 {
			return c
		}
		return cmp.Compare(a.row.JobID, b.row.JobID)
	})

	origin := optionalTime(run.GetRunStartedAt().Time)
	var end *time.Time
	for _, e := range entries {
		origin = earliest(origin, e.row.QueuedAt)
		origin = earliest(origin, e.row.StartedAt)
		end = latest(end, e.row.CompletedAt)
	}

	timeline := RunTimeline{
		Repo:         data.RunRepositories[runID],
		RunID:        runID,
		RunAttempt:   attempt,
		Workflow:     run.GetName(),
		WorkflowPath: run.GetPath(),
		Event:        run.GetEvent(),
		Branch:       run.GetHeadBranch(),
		HeadSHA:      run.GetHeadSHA(),
		URL:          run.GetHTMLURL(),
		Status:       run.GetStatus(),
		Conclusion:   run.GetConclusion(),
		StartedAt:    origin,
		CompletedAt:  end,
		Duration:     span(origin, end),
		Jobs:         make([]TimelineJob, 0, len(entries)),
	}

	for _, e := range entries {
		job := TimelineJob{
			JobID:         e.row.JobID,
			Name:          e.row.JobName,
			URL:           e.raw.GetHTMLURL(),
			Labels:        e.row.Labels,
			Kind:          e.row.Kind,
			RunnerID:      e.row.RunnerID,
			RunnerName:    e.row.RunnerName,
			RunnerGroup:   e.row.RunnerGroup,
			Status:        e.row.Status,
			Conclusion:    e.row.Conclusion,
			QueuedAt:      e.row.QueuedAt,
			StartedAt:     e.row.StartedAt,
			CompletedAt:   e.row.CompletedAt,
			Wait:          e.row.Wait,
			Duration:      e.row.Duration,
			QueuedOffset:  span(origin, e.row.QueuedAt),
			StartedOffset: span(origin, e.row.StartedAt),
		}
		for _, step := range stepRowsOf(e.row, e.raw.Steps, nil) {
			job.Steps = append(job.Steps, TimelineStep{
				Number:      step.StepNumber,
				Name:        step.StepName,
				Key:         step.StepKey,
				Occurrence:  step.StepOccurrence,
				Status:      step.StepStatus,
				Conclusion:  step.StepConclusion,
				StartedAt:   step.StartedAt,
				CompletedAt: step.CompletedAt,
				Duration:    step.Duration,
				Offset:      span(origin, step.StartedAt),
				JobOffset:   step.Offset,
			})
		}
		timeline.Jobs = append(timeline.Jobs, job)
	}
	if timeline.Workflow == "" && len(entries) > 0 {
		timeline.Workflow = entries[0].row.Workflow
	}
	return timeline
}

// earliest returns the earlier of two optional timestamps, ignoring an unset one.
func earliest(a, b *time.Time) *time.Time {
	if a == nil || (b != nil && b.Before(*a)) {
		return b
	}
	return a
}

// latest returns the later of two optional timestamps, ignoring an unset one.
func latest(a, b *time.Time) *time.Time {
	if a == nil || (b != nil && b.After(*a)) {
		return b
	}
	return a
}
