package metrics

import (
	"context"
	"fmt"
	"sync"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	"golang.org/x/sync/errgroup"
)

// mergeCollectedJobs keeps one execution per job ID, including carried-over jobs.
func mergeCollectedJobs(latest, historical []*github.WorkflowJob) []*github.WorkflowJob {
	seen := make(map[int64]bool, len(latest)+len(historical))
	jobs := make([]*github.WorkflowJob, 0, len(latest)+len(historical))
	for _, job := range append(latest, historical...) {
		if !seen[job.GetID()] {
			seen[job.GetID()] = true
			jobs = append(jobs, job)
		}
	}
	return jobs
}

func (c *Collector) collectHistoricalJobs(ctx context.Context, repo repository.Repository, runs []*github.WorkflowRun) ([]*github.WorkflowRun, []*github.WorkflowJob, []string, error) {
	fetcher := c.attemptJobs
	if fetcher == nil {
		fetcher = NewAPIAttemptJobFetcher(c.client)
	}
	var mu sync.Mutex
	var attempts []*github.WorkflowRun
	var jobs []*github.WorkflowJob
	var warnings []string
	group, ctx := errgroup.WithContext(ctx)
	group.SetLimit(c.opts.Concurrency)
	for _, latest := range runs {
		for attempt := 1; attempt < latest.GetRunAttempt(); attempt++ {
			group.Go(func() error {
				run, err := FetchRunAttempt(ctx, c.client, repo, latest.GetID(), attempt)
				var rows []*github.WorkflowJob
				if err == nil {
					rows, err = fetcher.Jobs(ctx, repo, run)
				}
				if err != nil && !isSkippableRunRequestError(err) {
					return err
				}
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					warnings = append(warnings, fmt.Sprintf("historical run %d attempt %d is unavailable: %v", latest.GetID(), attempt, err))
					return nil
				}
				attempts = append(attempts, run)
				jobs = append(jobs, rows...)
				if len(rows) == 0 {
					warnings = append(warnings, fmt.Sprintf("historical run %d attempt %d returned no jobs; GitHub may no longer retain them", latest.GetID(), attempt))
				}
				return nil
			})
		}
	}
	if err := group.Wait(); err != nil {
		return nil, nil, nil, err
	}
	return attempts, jobs, warnings, nil
}
