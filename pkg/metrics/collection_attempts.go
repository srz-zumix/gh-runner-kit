package metrics

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
	"golang.org/x/sync/errgroup"
)

func (c *Collector) historicalRun(ctx context.Context, repo repository.Repository, runID int64, attempt int) (*github.WorkflowRun, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if c.attemptCache != nil && !c.refreshAttempts {
		if run, ok := c.attemptCache.LoadRunAttempt(repo, runID, attempt); ok {
			return run, true, nil
		}
	}
	run, err := FetchRunAttempt(ctx, c.client, repo, runID, attempt)
	if err != nil {
		return nil, false, err
	}
	if c.attemptCache != nil && run.GetStatus() == "completed" {
		if err := c.attemptCache.SaveRunAttempt(repo, runID, attempt, run); err != nil {
			logger.Debug("metrics: failed to cache attempt metadata", "run_id", runID, "attempt", attempt, "error", err)
		}
	}
	return run, false, nil
}

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
	total := 0
	for _, run := range runs {
		total += max(0, run.GetRunAttempt()-1)
	}
	if err := c.progress.stage("attempts", parser.GetRepositoryFullName(repo), "attempts", total); err != nil {
		return nil, nil, nil, err
	}
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
				run, metadataCached, err := c.historicalRun(ctx, repo, latest.GetID(), attempt)
				var rows []*github.WorkflowJob
				var cached bool
				if err == nil {
					rows, cached, err = fetchJobsWithCache(ctx, fetcher, repo, run)
				}
				if err != nil && !isSkippableRunRequestError(err) {
					return err
				}
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					warnings = append(warnings, fmt.Sprintf("historical run %d attempt %d is unavailable: %v", latest.GetID(), attempt, err))
					return c.progress.advance(false, true)
				}
				attempts = append(attempts, run)
				jobs = append(jobs, rows...)
				if len(rows) == 0 {
					warnings = append(warnings, fmt.Sprintf("historical run %d attempt %d returned no jobs; GitHub may no longer retain them", latest.GetID(), attempt))
				}
				return c.progress.advance(metadataCached && cached, false)
			})
		}
	}
	if err := errors.Join(group.Wait(), c.progress.flush()); err != nil {
		return nil, nil, nil, err
	}
	return attempts, jobs, warnings, nil
}
