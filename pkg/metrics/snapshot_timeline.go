package metrics

import (
	"fmt"
	"slices"
	"strings"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

// BuildSnapshotTimeline reads a retained attempt without making any API request.
func BuildSnapshotTimeline(snapshot *Snapshot, ref RunRef, opts TimelineOptions) (RunTimeline, error) {
	if err := snapshot.Require(true, false); err != nil {
		return RunTimeline{}, err
	}
	data := snapshot.Data
	if ref.JobID > 0 {
		var found *github.WorkflowJob
		for _, job := range data.Jobs {
			if job.GetID() == ref.JobID && job.GetRunID() == ref.RunID {
				found = job
				break
			}
		}
		if found == nil {
			return RunTimeline{}, fmt.Errorf("job %d is not present in the shared snapshot", ref.JobID)
		}
		if ref.Attempt == 0 {
			ref.Attempt = int(found.GetRunAttempt())
		}
		opts.JobID = ref.JobID
	}
	var selected *github.WorkflowRun
	for _, run := range append(slices.Clone(data.Runs), data.Attempts...) {
		if run.GetID() != ref.RunID {
			continue
		}
		if ref.Attempt > 0 && run.GetRunAttempt() != ref.Attempt {
			continue
		}
		if selected == nil || run.GetRunAttempt() > selected.GetRunAttempt() {
			selected = run
		}
	}
	if selected == nil {
		return RunTimeline{}, fmt.Errorf("run %d attempt %d is not present in the shared snapshot", ref.RunID, ref.Attempt)
	}
	repo := repository.Repository{Host: snapshot.Repo.Host}
	name := data.RunRepositories[ref.RunID]
	if name == "" {
		return RunTimeline{}, fmt.Errorf("run %d has no repository in the shared snapshot", ref.RunID)
	}
	parsed, err := repository.Parse(name)
	if err != nil {
		return RunTimeline{}, err
	}
	repo.Owner, repo.Name = parsed.Owner, parsed.Name
	if ref.Repo != nil && (!strings.EqualFold(ref.Repo.Owner, repo.Owner) || !strings.EqualFold(ref.Repo.Name, repo.Name) || (ref.Repo.Host != "" && !strings.EqualFold(ref.Repo.Host, repo.Host))) {
		return RunTimeline{}, fmt.Errorf("run %d does not belong to the requested repository in the shared snapshot", ref.RunID)
	}
	var jobs []*github.WorkflowJob
	for _, job := range data.Jobs {
		if job.GetRunID() == ref.RunID {
			jobs = append(jobs, job)
		}
	}
	return BuildRunTimeline(repo, selected, jobs, opts), nil
}
