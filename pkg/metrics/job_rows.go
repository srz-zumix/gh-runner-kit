package metrics

import (
	"cmp"
	"fmt"
	"path"
	"slices"
	"strconv"
	"time"

	"github.com/google/go-github/v90/github"
)

// Runner kinds accepted by the job listing filter.
const (
	JobKindFilterAll        = "all"
	JobKindFilterSelfHosted = "self-hosted"
	JobKindFilterHosted     = "github-hosted"
)

// JobKindFilters lists every accepted runner kind filter.
var JobKindFilters = []string{JobKindFilterAll, JobKindFilterSelfHosted, JobKindFilterHosted}

// JobRow is one collected workflow job, left unaggregated so that a downstream tool can
// group the jobs on an axis the aggregated reports do not offer.
type JobRow struct {
	Repo         string
	RunID        int64
	RunAttempt   int64
	JobID        int64
	Workflow     string
	WorkflowPath string
	JobName      string
	Event        string
	Branch       string
	Labels       []string
	Kind         JobKind
	RunnerID     int64
	RunnerName   string
	RunnerGroup  string
	Status       string
	Conclusion   string
	QueuedAt     *time.Time
	StartedAt    *time.Time
	CompletedAt  *time.Time
	Wait         time.Duration
	Duration     time.Duration
}

// LabelSet renders the runs-on set the job requested.
func (r JobRow) LabelSet() string {
	return formatLabelSet(r.Labels)
}

// JobRowOptions narrows which jobs the listing keeps.
type JobRowOptions struct {
	// Labels keeps the jobs whose runs-on set carries every one of them.
	Labels []string
	// Runners keeps the jobs whose runner name matches any of these patterns, where *
	// stands for any sequence of characters.
	Runners []string
	// ExcludeRunners drops the jobs whose runner name matches any of these patterns,
	// which accept the same wildcard as Runners.
	ExcludeRunners []string
	// Kind keeps the jobs of a single runner kind. An empty value keeps them all.
	Kind string
	// Limit caps how many rows survive the filters. 0 keeps all of them.
	Limit int
}

// Validate reports whether the options can be applied, so that a malformed runner
// pattern is rejected before any workflow run is collected rather than silently
// matching nothing.
func (o JobRowOptions) Validate() error {
	if err := validateRunnerPatterns("--runner", o.Runners); err != nil {
		return err
	}
	if err := validateRunnerPatterns("--exclude-runner", o.ExcludeRunners); err != nil {
		return err
	}
	if o.Limit < 0 {
		return fmt.Errorf("--limit must not be negative, got %d", o.Limit)
	}
	return nil
}

// validateRunnerPatterns reports the first pattern path.Match cannot parse, naming the
// flag it came from.
func validateRunnerPatterns(flag string, patterns []string) error {
	for _, pattern := range patterns {
		if _, err := path.Match(pattern, ""); err != nil {
			return fmt.Errorf("invalid %s pattern %q: %w", flag, pattern, err)
		}
	}
	return nil
}

// matchKind reports whether kind passes the runner kind filter. The self-hosted filter
// keeps the jobs whose runner could not be identified, the same way the other reports
// treat them as fleet activity.
func (o JobRowOptions) matchKind(kind JobKind) bool {
	switch o.Kind {
	case JobKindFilterSelfHosted:
		return kind != JobKindHosted
	case JobKindFilterHosted:
		return kind == JobKindHosted
	default:
		return true
	}
}

// matchRunner reports whether name passes the runner name filters. An exclusion wins
// over an inclusion, so a name matching both patterns is dropped.
func (o JobRowOptions) matchRunner(name string) bool {
	if len(o.Runners) > 0 && !matchesAnyRunnerPattern(o.Runners, name) {
		return false
	}
	return !matchesAnyRunnerPattern(o.ExcludeRunners, name)
}

// matchesAnyRunnerPattern reports whether name matches at least one of the patterns.
func matchesAnyRunnerPattern(patterns []string, name string) bool {
	for _, pattern := range patterns {
		// Validate already rejected the malformed patterns, so a match error here can
		// only mean the name does not match.
		if ok, err := path.Match(pattern, name); err == nil && ok {
			return true
		}
	}
	return false
}

// normalizeRunnerName drops the runner ID GitHub appends to the name of its own hosted
// runners, so that every hosted job reports the same runner instead of one name per
// machine. It only rewrites jobs classified as hosted, so a self-hosted runner that is
// deliberately named after its own registration ID keeps its name, and the ID is only
// dropped when the name is exactly the hosted prefix followed by it, which leaves a
// self-hosted name that happens to end in a number untouched. The ID stays available in
// RunnerID.
func normalizeRunnerName(kind JobKind, name string, id int64) string {
	if kind == JobKindHosted && id != 0 && name == hostedRunnerGroup+" "+strconv.FormatInt(id, 10) {
		return hostedRunnerGroup
	}
	return name
}

// BuildJobRows turns the collected jobs into one row each, ordered by the instant they
// started so that the same collection always produces the same listing. Unlike the
// aggregated reports it keeps the jobs that were skipped and the jobs that have not
// finished yet, reporting their missing timestamps as unset, because a listing exists to
// show what was collected. Only the check runs apps publish alongside the jobs are left
// out, because they are not jobs at all.
func BuildJobRows(data *Data, opts JobRowOptions) []JobRow {
	filter := NormalizeLabelSet(opts.Labels)
	runnerIDs := data.SelfHostedRunnerIDs()

	// Index the runs by ID so each job can borrow the event and the workflow file path
	// that its raw job record does not carry.
	runByID := make(map[int64]*github.WorkflowRun, len(data.Runs))
	for _, run := range data.Runs {
		runByID[run.GetID()] = run
	}

	rows := make([]JobRow, 0, len(data.Jobs))
	for _, raw := range data.Jobs {
		// Check runs published by apps share the check suite of the workflow run, so the
		// jobs API returns them too. They carry no runs-on labels, which every real job
		// has. See NewJobs.
		if len(raw.Labels) == 0 {
			continue
		}

		kind := ClassifyJob(raw, runnerIDs)
		if !opts.matchKind(kind) {
			continue
		}
		// A job passes the label filter when its runs-on set carries every requested
		// label, which is the same subset test a runner has to satisfy to pick it up.
		if len(filter) > 0 && !MatchesRunner(filter, raw.Labels) {
			continue
		}
		runnerName := normalizeRunnerName(kind, raw.GetRunnerName(), raw.GetRunnerID())
		if !opts.matchRunner(runnerName) {
			continue
		}

		runID := raw.GetRunID()
		run := runByID[runID]
		queued := optionalTime(raw.GetCreatedAt().Time)
		started := optionalTime(raw.GetStartedAt().Time)
		completed := optionalTime(raw.GetCompletedAt().Time)

		rows = append(rows, JobRow{
			Repo:         data.RunRepositories[runID],
			RunID:        runID,
			RunAttempt:   raw.GetRunAttempt(),
			JobID:        raw.GetID(),
			Workflow:     raw.GetWorkflowName(),
			WorkflowPath: run.GetPath(),
			JobName:      raw.GetName(),
			Event:        run.GetEvent(),
			Branch:       raw.GetHeadBranch(),
			Labels:       raw.Labels,
			Kind:         kind,
			RunnerID:     raw.GetRunnerID(),
			RunnerName:   runnerName,
			RunnerGroup:  raw.GetRunnerGroupName(),
			Status:       raw.GetStatus(),
			Conclusion:   raw.GetConclusion(),
			QueuedAt:     queued,
			StartedAt:    started,
			CompletedAt:  completed,
			Wait:         span(queued, started),
			Duration:     span(started, completed),
		})
	}

	slices.SortFunc(rows, func(a, b JobRow) int {
		if c := compareOptionalTime(a.StartedAt, b.StartedAt); c != 0 {
			return c
		}
		if c := compareOptionalTime(a.QueuedAt, b.QueuedAt); c != 0 {
			return c
		}
		// The jobs are collected in parallel, so their arrival order is not stable and
		// the ID is what keeps equally timed jobs in a reproducible order.
		return cmp.Compare(a.JobID, b.JobID)
	})

	if opts.Limit > 0 && len(rows) > opts.Limit {
		rows = rows[:opts.Limit]
	}
	return rows
}

// optionalTime keeps a timestamp GitHub never recorded distinguishable from the zero
// instant, which would otherwise be exported as a year 1 date.
func optionalTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	return &t
}

// span is the time between two timestamps, or 0 when either of them is unset.
func span(from, to *time.Time) time.Duration {
	if from == nil || to == nil {
		return 0
	}
	return nonNegative(to.Sub(*from))
}

// compareOptionalTime orders timestamps chronologically and puts the unset ones last, so
// that the jobs which never started end up at the bottom of the listing.
func compareOptionalTime(a, b *time.Time) int {
	switch {
	case a == nil && b == nil:
		return 0
	case a == nil:
		return 1
	case b == nil:
		return -1
	default:
		return a.Compare(*b)
	}
}
