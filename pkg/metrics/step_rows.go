package metrics

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/google/go-github/v90/github"
)

// StepRow is one step of a collected workflow job, left unaggregated so that a
// downstream tool can build its own step statistics. It repeats the identity of the job
// that ran it, so every row stands on its own.
type StepRow struct {
	Repo       string
	RunID      int64
	RunAttempt int64
	// RunStartedAt is when the run attempt the job belongs to started. It is unset when
	// the job comes from an earlier attempt than the one the collected run describes,
	// because GitHub reports the start of the latest attempt only.
	RunStartedAt   *time.Time
	JobID          int64
	Workflow       string
	WorkflowPath   string
	JobName        string
	Event          string
	Branch         string
	Labels         []string
	Kind           JobKind
	RunnerName     string
	RunnerGroup    string
	JobConclusion  string
	JobQueuedAt    *time.Time
	JobStartedAt   *time.Time
	JobCompletedAt *time.Time
	StepNumber     int64
	StepName       string
	// StepKey identifies the step inside its job. It is the step name, followed by
	// " #N" for the Nth step of the same job that shares that name, so that steps
	// repeating a name are not merged into one.
	StepKey        string
	StepStatus     string
	StepConclusion string
	StartedAt      *time.Time
	CompletedAt    *time.Time
	// Duration is how long the step ran, or 0 when it never started or never finished.
	Duration time.Duration
	// Offset is how long after the job started the step started, or 0 when either of
	// them is unknown.
	Offset time.Duration
}

// LabelSet renders the runs-on set the job requested.
func (r StepRow) LabelSet() string {
	return formatLabelSet(r.Labels)
}

// StepRowOptions narrows which steps the listing keeps.
type StepRowOptions struct {
	JobRowOptions
	// Jobs keeps the steps of the jobs whose name matches any of these patterns, where
	// * stands for any sequence of characters, including a slash.
	Jobs []string
	// Steps keeps the steps whose name matches any of these patterns, which accept the
	// same wildcard as Jobs.
	Steps []string
}

// Validate reports whether the options can be applied.
func (o StepRowOptions) Validate() error {
	if err := o.JobRowOptions.Validate(); err != nil {
		return err
	}
	if err := validateNamePatterns("--job", o.Jobs); err != nil {
		return err
	}
	return validateNamePatterns("--step", o.Steps)
}

// validateNamePatterns rejects an empty pattern, which could only ever match a nameless
// job or step and is almost certainly a mistake.
func validateNamePatterns(flag string, patterns []string) error {
	for _, pattern := range patterns {
		if pattern == "" {
			return fmt.Errorf("%s pattern must not be empty", flag)
		}
	}
	return nil
}

// JobFilter returns the options without the step name filter and the limit, which
// select the same jobs the step listing draws its steps from. A step statistic divides
// by the number of these jobs to tell how often a step runs at all.
func (o StepRowOptions) JobFilter() JobRowOptions {
	opts := o.JobRowOptions
	opts.Limit = 0
	return opts
}

// MatchJob reports whether a job name passes the job name filter.
func (o StepRowOptions) MatchJob(name string) bool {
	return len(o.Jobs) == 0 || matchesAnyNamePattern(o.Jobs, name)
}

// matchStep reports whether a step name passes the step name filter.
func (o StepRowOptions) matchStep(name string) bool {
	return len(o.Steps) == 0 || matchesAnyNamePattern(o.Steps, name)
}

func matchesAnyNamePattern(patterns []string, name string) bool {
	for _, pattern := range patterns {
		if MatchWildcard(pattern, name) {
			return true
		}
	}
	return false
}

// MatchWildcard reports whether name matches pattern, where * stands for any sequence of
// characters and every other character matches itself. Unlike path.Match, * also
// matches a slash, because job and step names such as "Run actions/checkout@v4" are not
// paths.
func MatchWildcard(pattern, name string) bool {
	parts := strings.Split(pattern, "*")
	if len(parts) == 1 {
		return pattern == name
	}
	if !strings.HasPrefix(name, parts[0]) {
		return false
	}
	name = name[len(parts[0]):]
	last := parts[len(parts)-1]
	for _, part := range parts[1 : len(parts)-1] {
		i := strings.Index(name, part)
		if i < 0 {
			return false
		}
		name = name[i+len(part):]
	}
	return strings.HasSuffix(name, last)
}

// BuildStepRows turns the steps of the collected jobs into one row each. A job is
// selected exactly the way BuildJobRows selects it, then narrowed by the job name
// filter, and its steps are narrowed by the step name filter. Like the job listing it
// keeps the steps that were skipped and the ones that have not finished, reporting
// their missing timestamps as unset. The rows are ordered by the instant their job
// started and then by step number, and Limit caps how many of them are returned.
func BuildStepRows(data *Data, opts StepRowOptions) []StepRow {
	b := newJobRowBuilder(data, opts.JobFilter())

	type jobEntry struct {
		job JobRow
		raw *github.WorkflowJob
	}
	jobs := make([]jobEntry, 0, len(data.Jobs))
	for _, raw := range data.Jobs {
		job, ok := b.build(raw)
		if !ok || !opts.MatchJob(job.JobName) {
			continue
		}
		jobs = append(jobs, jobEntry{job: job, raw: raw})
	}
	slices.SortFunc(jobs, func(a, b jobEntry) int {
		if c := compareOptionalTime(a.job.StartedAt, b.job.StartedAt); c != 0 {
			return c
		}
		if c := compareOptionalTime(a.job.QueuedAt, b.job.QueuedAt); c != 0 {
			return c
		}
		return cmp.Compare(a.job.JobID, b.job.JobID)
	})

	rows := make([]StepRow, 0)
	for _, entry := range jobs {
		runStarted := runAttemptStartedAt(b.run(entry.job.RunID), entry.job.RunAttempt)
		for _, row := range stepRowsOf(entry.job, entry.raw.Steps, runStarted) {
			if !opts.matchStep(row.StepName) {
				continue
			}
			rows = append(rows, row)
			if opts.Limit > 0 && len(rows) >= opts.Limit {
				return rows
			}
		}
	}
	return rows
}

// runAttemptStartedAt returns when the given attempt of run started, which GitHub only
// reports for the latest attempt.
func runAttemptStartedAt(run *github.WorkflowRun, attempt int64) *time.Time {
	if run == nil || int64(run.GetRunAttempt()) != attempt {
		return nil
	}
	return optionalTime(run.GetRunStartedAt().Time)
}

// stepRowsOf converts the steps of one job, in step number order, into rows.
func stepRowsOf(job JobRow, steps []*github.TaskStep, runStarted *time.Time) []StepRow {
	ordered := slices.Clone(steps)
	slices.SortStableFunc(ordered, func(a, b *github.TaskStep) int {
		return cmp.Compare(a.GetNumber(), b.GetNumber())
	})

	seen := make(map[string]int, len(ordered))
	rows := make([]StepRow, 0, len(ordered))
	for _, step := range ordered {
		if step == nil {
			continue
		}
		name := step.GetName()
		seen[name]++
		started := optionalTime(step.GetStartedAt().Time)
		completed := optionalTime(step.GetCompletedAt().Time)
		rows = append(rows, StepRow{
			Repo:           job.Repo,
			RunID:          job.RunID,
			RunAttempt:     job.RunAttempt,
			RunStartedAt:   runStarted,
			JobID:          job.JobID,
			Workflow:       job.Workflow,
			WorkflowPath:   job.WorkflowPath,
			JobName:        job.JobName,
			Event:          job.Event,
			Branch:         job.Branch,
			Labels:         job.Labels,
			Kind:           job.Kind,
			RunnerName:     job.RunnerName,
			RunnerGroup:    job.RunnerGroup,
			JobConclusion:  job.Conclusion,
			JobQueuedAt:    job.QueuedAt,
			JobStartedAt:   job.StartedAt,
			JobCompletedAt: job.CompletedAt,
			StepNumber:     step.GetNumber(),
			StepName:       name,
			StepKey:        StepKey(name, seen[name]),
			StepStatus:     step.GetStatus(),
			StepConclusion: step.GetConclusion(),
			StartedAt:      started,
			CompletedAt:    completed,
			Duration:       span(started, completed),
			Offset:         span(job.StartedAt, started),
		})
	}
	return rows
}

// StepKey identifies the occurrence-th step named name inside one job.
func StepKey(name string, occurrence int) string {
	if occurrence <= 1 {
		return name
	}
	return name + " #" + strconv.Itoa(occurrence)
}
