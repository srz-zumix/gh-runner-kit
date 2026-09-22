package metrics

import (
	"cmp"
	"slices"
	"time"

	"github.com/google/go-github/v90/github"
)

// WorkflowRow is one line of the metrics workflow report.
type WorkflowRow struct {
	Repository   string
	Workflow     string
	WorkflowPath string
	Runs         int
	Jobs         int
	Failed       int
	Decided      int
	Retried      int
	FailureRate  float64
	RetryRate    float64
	WaitP50      time.Duration
	WaitP95      time.Duration
	DurationP50  time.Duration
	DurationP95  time.Duration
	BusyTime     time.Duration
	LastJobAt    time.Time
}

// RepositoryRow aggregates every workflow in a repository into one row.
type RepositoryRow struct {
	Repository  string
	Runs        int
	Jobs        int
	Failed      int
	Decided     int
	Retried     int
	FailureRate float64
	RetryRate   float64
	BusyTime    time.Duration
	LastJobAt   time.Time
}

// workflowKey identifies a workflow across repositories. The repository is always part of
// the key so equally named workflows of different repositories never merge, which matters
// under --all-repos. The remaining fields fall back through the identity signals a job
// exposes: the stable workflow file ID first, then the workflow file path, then the display
// name. tier records which signal was used so two keys only collide when they identify the
// workflow the same way.
type workflowKey struct {
	repository string
	tier       int
	id         int64
	path       string
	name       string
}

const (
	workflowTierID   = 0
	workflowTierPath = 1
	workflowTierName = 2
)

// keyOf derives the grouping key of a job, preferring the most reliable identity signal it
// carries. It never collapses distinct workflows that merely lack richer metadata.
func keyOf(job Job) workflowKey {
	key := workflowKey{repository: job.Repository}
	switch {
	case job.WorkflowID != 0:
		key.tier = workflowTierID
		key.id = job.WorkflowID
	case job.WorkflowPath != "":
		key.tier = workflowTierPath
		key.path = job.WorkflowPath
	default:
		key.tier = workflowTierName
		key.name = job.Workflow
	}
	return key
}

// BuildWorkflowStats aggregates the jobs per workflow. selfHostedOnly drops the jobs
// that ran on GitHub-hosted runners, which the other reports always do; this report
// keeps them by default so that a workflow can be judged as a whole.
func BuildRepositoryStats(data *Data) []RepositoryRow {
	jobs := FleetJobs(NewJobs(data))
	stats := map[string]*jobStats{}
	runAttempts := map[string]map[int64]bool{}
	for _, job := range jobs {
		repo := job.Repository
		if repo == "" {
			repo = data.RunRepositories[job.RunID]
		}
		if repo == "" {
			repo = repoNameForRun(data, job.RunID)
		}
		if repo == "" {
			repo = unknownKey
		}
		if _, ok := stats[repo]; !ok {
			stats[repo] = &jobStats{}
			runAttempts[repo] = map[int64]bool{}
		}
		stats[repo].add(job, data.Window)
		runAttempts[repo][job.RunID] = true
	}

	rows := make([]RepositoryRow, 0, len(stats))
	for repo, s := range stats {
		retried := 0
		for runID := range runAttempts[repo] {
			if run, ok := lookupRunByID(data, runID); ok && run.GetRunAttempt() > 1 {
				retried++
			}
		}
		row := RepositoryRow{
			Repository:  repo,
			Runs:        len(runAttempts[repo]),
			Jobs:        s.count,
			Failed:      s.failed,
			Decided:     s.decided,
			Retried:     retried,
			FailureRate: s.failureRate(),
			BusyTime:    s.busy,
			LastJobAt:   s.lastJobAt,
		}
		if row.Runs > 0 {
			row.RetryRate = float64(retried) / float64(row.Runs)
		}
		rows = append(rows, row)
	}

	slices.SortFunc(rows, func(a, b RepositoryRow) int {
		if c := cmp.Compare(b.Jobs, a.Jobs); c != 0 {
			return c
		}
		return cmp.Compare(a.Repository, b.Repository)
	})
	return rows
}

func repoNameForRun(data *Data, runID int64) string {
	if repo, ok := data.RunRepositories[runID]; ok && repo != "" {
		return repo
	}
	if run, ok := lookupRunByID(data, runID); ok {
		for _, repo := range data.Repos {
			if repo.Runs > 0 && len(data.Repos) == 1 {
				return repo.FullName()
			}
			if repo.FullName() == data.RunRepositories[run.GetID()] {
				return repo.FullName()
			}
		}
	}
	if len(data.Repos) == 1 {
		return data.Repos[0].FullName()
	}
	return ""
}

func lookupRunByID(data *Data, runID int64) (*github.WorkflowRun, bool) {
	for _, run := range data.Runs {
		if run.GetID() == runID {
			return run, true
		}
	}
	return nil, false
}

func BuildWorkflowStats(data *Data, selfHostedOnly bool) []WorkflowRow {
	jobs := NewJobs(data)
	if selfHostedOnly {
		jobs = FleetJobs(jobs)
	}

	attempts := map[int64]int{}
	for _, run := range data.Runs {
		attempts[run.GetID()] = run.GetRunAttempt()
	}

	stats := map[workflowKey]*jobStats{}
	runIDs := map[workflowKey]map[int64]bool{}
	// display keeps the human-facing fields of the first job seen for each key, so the
	// report shows the workflow name and path even when the key is built from the ID.
	display := map[workflowKey]Job{}
	for _, job := range jobs {
		key := keyOf(job)

		s, ok := stats[key]
		if !ok {
			s = &jobStats{}
			stats[key] = s
			runIDs[key] = map[int64]bool{}
			display[key] = job
		}
		s.add(job, data.Window)
		runIDs[key][job.RunID] = true
	}

	rows := make([]WorkflowRow, 0, len(stats))
	for key, s := range stats {
		sample := display[key]
		name := sample.Workflow
		if name == "" {
			name = unknownKey
		}
		row := WorkflowRow{
			Repository:   sample.Repository,
			Workflow:     name,
			WorkflowPath: sample.WorkflowPath,
			Runs:         len(runIDs[key]),
			Jobs:         s.count,
			Failed:       s.failed,
			Decided:      s.decided,
			FailureRate:  s.failureRate(),
			WaitP50:      Percentile(s.waits, 50),
			WaitP95:      Percentile(s.waits, 95),
			DurationP50:  Percentile(s.durations, 50),
			DurationP95:  Percentile(s.durations, 95),
			BusyTime:     s.busy,
			LastJobAt:    s.lastJobAt,
		}

		// An attempt above 1 means the run was restarted. It is the only retry signal
		// the API exposes, because the job list of a run only covers its last attempt.
		retried := 0
		for runID := range runIDs[key] {
			if attempts[runID] > 1 {
				retried++
			}
		}
		row.Retried = retried
		if row.Runs > 0 {
			row.RetryRate = float64(retried) / float64(row.Runs)
		}
		rows = append(rows, row)
	}

	slices.SortFunc(rows, func(a, b WorkflowRow) int {
		if c := cmp.Compare(b.Jobs, a.Jobs); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Repository, b.Repository); c != 0 {
			return c
		}
		if c := cmp.Compare(a.Workflow, b.Workflow); c != 0 {
			return c
		}
		return cmp.Compare(a.WorkflowPath, b.WorkflowPath)
	})
	return rows
}
