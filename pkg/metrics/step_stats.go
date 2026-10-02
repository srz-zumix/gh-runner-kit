package metrics

import (
	"cmp"
	"slices"
	"strings"
	"time"
)

// Step conclusions the statistics tell apart.
const (
	stepConclusionSkipped = "skipped"
	stepConclusionFailure = "failure"
)

// StepStat aggregates every occurrence of one step of one job across the collected runs.
type StepStat struct {
	Repo     string
	Workflow string
	// WorkflowPath is the workflow file the statistic belongs to. Two workflow files
	// can share a display name, so the statistics are grouped by it rather than by
	// Workflow.
	WorkflowPath string
	// JobName is the job the step belongs to. When matrix jobs are merged it is the
	// name shared by every variant, without the trailing matrix values.
	JobName string
	// Variants is how many distinct job names were merged into JobName, which is 1
	// unless matrix jobs were merged.
	Variants int
	// StepKey is the display label of the step. StepName and StepOccurrence identify
	// it, because a step literally named "Upload #2" shares its label with the second
	// "Upload" of the job.
	StepKey        string
	StepName       string
	StepOccurrence int
	// Jobs is how many of the selected jobs could have run the step. It counts every
	// job of JobName that ran at least one step, whether or not it ran this one.
	Jobs int
	// Executed is how many of those jobs started the step. A step that was neither
	// skipped nor started, such as one of a job that is still running or was
	// cancelled before reaching it, counts as neither.
	Executed int
	Skipped  int
	// Failed is how many of the executed occurrences failed.
	Failed int
	// Samples is how many executed occurrences recorded both a start and an end, which
	// are the only ones the duration percentiles and Share are computed from.
	Samples int
	P50     time.Duration
	P90     time.Duration
	Max     time.Duration
	// Share is the median fraction of its job's duration the step took.
	Share float64
	// Offset is the median time between the job start and the step start.
	Offset time.Duration
}

// Presence is the fraction of Jobs that executed the step.
func (s StepStat) Presence() float64 {
	if s.Jobs == 0 {
		return 0
	}
	return float64(s.Executed) / float64(s.Jobs)
}

// FailureRate is the fraction of the executed occurrences that failed.
func (s StepStat) FailureRate() float64 {
	if s.Executed == 0 {
		return 0
	}
	return float64(s.Failed) / float64(s.Executed)
}

// StepStatOptions controls how BuildStepStats groups the steps.
type StepStatOptions struct {
	// MergeMatrix folds the variants of a matrix job, such as "test (ubuntu, 1.22)"
	// and "test (macos, 1.22)", into one job named "test". A job name is only folded
	// when at least two names of the same workflow share the same prefix, so a job
	// whose name merely ends in parentheses is left alone.
	MergeMatrix bool
	// Limit caps how many statistics are returned. 0 returns all of them. Every step
	// still contributes to the aggregation, whatever the limit.
	Limit int
}

type stepStatKey struct {
	repo, workflow, job, step string
	occurrence                int
}

// jobGroupKey identifies a job of a workflow. workflow is the workflow file when it is
// known and the display name otherwise, so two files sharing a name stay apart.
type jobGroupKey struct {
	repo, workflow, job string
}

// workflowIdentity is the workflow file when it is known, or the display name.
func workflowIdentity(path, name string) string {
	if path != "" {
		return path
	}
	return name
}

// BuildStepStats aggregates the steps BuildStepRows would list for opts into one
// statistic per step of every job. The step rows are built without opts.Limit, so the
// limit never skews the aggregation. The statistics are ordered by repository,
// workflow, job and the median offset of the step, which approximates the order the
// steps usually run in.
func BuildStepStats(data *Data, opts StepRowOptions, statOpts StepStatOptions) []StepStat {
	rowOpts := opts
	rowOpts.Limit = 0
	rows := BuildStepRows(data, rowOpts)

	// The denominators come from every selected job that ran at least one step, so a
	// step filter does not hide the jobs that never ran the filtered step.
	jobsWithSteps := make(map[int64]bool)
	for _, raw := range data.Jobs {
		if len(raw.Steps) > 0 {
			jobsWithSteps[raw.GetID()] = true
		}
	}
	type jobInfo struct {
		key      jobGroupKey
		duration time.Duration
	}
	var jobs []jobInfo
	for _, job := range BuildJobRows(data, opts.JobFilter()) {
		if !jobsWithSteps[job.JobID] || !opts.MatchJob(job.JobName) {
			continue
		}
		jobs = append(jobs, jobInfo{
			key:      jobGroupKey{repo: job.Repo, workflow: workflowIdentity(job.WorkflowPath, job.Workflow), job: job.JobName},
			duration: job.Duration,
		})
	}

	rename := func(k jobGroupKey) (jobGroupKey, string) { return k, k.job }
	if statOpts.MergeMatrix {
		names := make([]jobGroupKey, 0, len(jobs))
		for _, job := range jobs {
			names = append(names, job.key)
		}
		merged := matrixJobNames(names)
		rename = func(k jobGroupKey) (jobGroupKey, string) {
			if base, ok := merged[k]; ok {
				return jobGroupKey{repo: k.repo, workflow: k.workflow, job: base}, k.job
			}
			return k, k.job
		}
	}

	jobCounts := make(map[jobGroupKey]int)
	variants := make(map[jobGroupKey]map[string]bool)
	for _, job := range jobs {
		group, original := rename(job.key)
		jobCounts[group]++
		if variants[group] == nil {
			variants[group] = make(map[string]bool)
		}
		variants[group][original] = true
	}

	type accumulator struct {
		stat      StepStat
		durations []time.Duration
		offsets   []time.Duration
		shares    []float64
	}
	accs := make(map[stepStatKey]*accumulator)
	for _, row := range rows {
		group, _ := rename(jobGroupKey{repo: row.Repo, workflow: workflowIdentity(row.WorkflowPath, row.Workflow), job: row.JobName})
		occurrence := max(row.StepOccurrence, 1)
		key := stepStatKey{repo: group.repo, workflow: group.workflow, job: group.job, step: row.StepName, occurrence: occurrence}
		acc := accs[key]
		if acc == nil {
			acc = &accumulator{stat: StepStat{
				Repo:           group.repo,
				Workflow:       row.Workflow,
				WorkflowPath:   row.WorkflowPath,
				JobName:        group.job,
				Variants:       max(len(variants[group]), 1),
				StepKey:        row.StepKey,
				StepName:       row.StepName,
				StepOccurrence: occurrence,
				Jobs:           jobCounts[group],
			}}
			accs[key] = acc
		}
		if row.StepConclusion == stepConclusionSkipped {
			acc.stat.Skipped++
			continue
		}
		if row.StartedAt == nil {
			continue
		}
		acc.stat.Executed++
		// A timed out step failed, like a timed out job does in Job.Failed.
		if row.StepConclusion == stepConclusionFailure || row.StepConclusion == conclusionTimedOut {
			acc.stat.Failed++
		}
		if row.CompletedAt == nil {
			continue
		}
		acc.stat.Samples++
		acc.durations = append(acc.durations, row.Duration)
		if row.JobStartedAt != nil {
			acc.offsets = append(acc.offsets, row.Offset)
		}
		if row.JobStartedAt != nil && row.JobCompletedAt != nil {
			if total := row.JobCompletedAt.Sub(*row.JobStartedAt); total > 0 {
				acc.shares = append(acc.shares, min(float64(row.Duration)/float64(total), 1))
			}
		}
	}

	stats := make([]StepStat, 0, len(accs))
	for _, acc := range accs {
		s := acc.stat
		// A job can count fewer runs than the step rows when the job row filters and
		// the step rows disagree, which never happens today but would otherwise yield
		// a presence above 100%.
		s.Jobs = max(s.Jobs, s.Executed+s.Skipped)
		if len(acc.durations) > 0 {
			s.P50 = Percentile(acc.durations, 50)
			s.P90 = Percentile(acc.durations, 90)
			s.Max = slices.Max(acc.durations)
		}
		if len(acc.offsets) > 0 {
			s.Offset = Percentile(acc.offsets, 50)
		}
		if len(acc.shares) > 0 {
			s.Share = Percentile(acc.shares, 50)
		}
		stats = append(stats, s)
	}

	slices.SortFunc(stats, func(a, b StepStat) int {
		return cmp.Or(
			cmp.Compare(a.Repo, b.Repo),
			cmp.Compare(a.Workflow, b.Workflow),
			cmp.Compare(a.WorkflowPath, b.WorkflowPath),
			cmp.Compare(a.JobName, b.JobName),
			cmp.Compare(a.Offset, b.Offset),
			cmp.Compare(a.StepKey, b.StepKey),
			cmp.Compare(a.StepName, b.StepName),
			cmp.Compare(a.StepOccurrence, b.StepOccurrence),
		)
	})

	if statOpts.Limit > 0 && len(stats) > statOpts.Limit {
		stats = stats[:statOpts.Limit]
	}
	return stats
}

// matrixJobNames maps every job name that looks like a matrix variant to the name it
// shares with its siblings. A name is a variant when it ends in a parenthesised group,
// such as "test (ubuntu, 1.22)", and at least one other name of the same repository and
// workflow ends in a different group after the same prefix. Names without a sibling are
// left out of the map.
func matrixJobNames(names []jobGroupKey) map[jobGroupKey]string {
	type prefixKey struct {
		repo, workflow, base string
	}
	members := make(map[prefixKey]map[string]bool)
	for _, name := range names {
		base, ok := matrixBaseName(name.job)
		if !ok {
			continue
		}
		key := prefixKey{repo: name.repo, workflow: name.workflow, base: base}
		if members[key] == nil {
			members[key] = make(map[string]bool)
		}
		members[key][name.job] = true
	}

	merged := make(map[jobGroupKey]string)
	for key, jobs := range members {
		if len(jobs) < 2 {
			continue
		}
		for job := range jobs {
			merged[jobGroupKey{repo: key.repo, workflow: key.workflow, job: job}] = key.base
		}
	}
	return merged
}

// matrixBaseName strips the trailing parenthesised group GitHub appends to the name of
// a matrix job, matching the parentheses so that nested values stay inside the group.
func matrixBaseName(name string) (string, bool) {
	if !strings.HasSuffix(name, ")") {
		return "", false
	}
	depth := 0
	for i := len(name) - 1; i >= 0; i-- {
		switch name[i] {
		case ')':
			depth++
		case '(':
			depth--
			if depth == 0 {
				if i == 0 || name[i-1] != ' ' {
					return "", false
				}
				base := name[:i-1]
				if base == "" {
					return "", false
				}
				return base, true
			}
		}
	}
	return "", false
}
