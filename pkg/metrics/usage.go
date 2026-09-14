package metrics

import (
	"context"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
)

// UsageFetcher retrieves the billable usage of a single workflow run.
type UsageFetcher interface {
	Usage(ctx context.Context, repo repository.Repository, run *github.WorkflowRun) (*github.WorkflowRunUsage, error)
}

// APIUsageFetcher reads run usage straight from the GitHub API.
type APIUsageFetcher struct {
	client *gh.GitHubClient
}

// NewAPIUsageFetcher builds a UsageFetcher backed by client.
func NewAPIUsageFetcher(client *gh.GitHubClient) *APIUsageFetcher {
	return &APIUsageFetcher{client: client}
}

// Usage implements UsageFetcher.
func (f *APIUsageFetcher) Usage(ctx context.Context, repo repository.Repository, run *github.WorkflowRun) (*github.WorkflowRunUsage, error) {
	var usage *github.WorkflowRunUsage
	err := withRetry(ctx, func() error {
		var err error
		usage, err = gh.GetWorkflowRunUsageByID(ctx, f.client, repo, run.GetID())
		return err
	})
	return usage, err
}

// CachedUsageFetcher serves run usage from disk before falling back to inner.
// Only completed runs are cached, because the billable time of a run still in progress
// keeps growing and would otherwise be frozen at its first observation.
type CachedUsageFetcher struct {
	inner   UsageFetcher
	cache   *Cache
	refresh bool
}

// NewCachedUsageFetcher wraps inner with cache. refresh ignores existing entries and
// rewrites them from the API.
func NewCachedUsageFetcher(inner UsageFetcher, cache *Cache, refresh bool) *CachedUsageFetcher {
	return &CachedUsageFetcher{inner: inner, cache: cache, refresh: refresh}
}

// Usage implements UsageFetcher.
func (f *CachedUsageFetcher) Usage(ctx context.Context, repo repository.Repository, run *github.WorkflowRun) (*github.WorkflowRunUsage, error) {
	cacheable := run.GetStatus() == "completed"
	runID := run.GetID()

	if cacheable && !f.refresh {
		if usage, ok := f.cache.LoadUsage(repo, runID); ok {
			logger.Debug("metrics: usage cache hit", "run_id", runID)
			return usage, nil
		}
	}

	usage, err := f.inner.Usage(ctx, repo, run)
	if err != nil {
		return nil, err
	}

	if cacheable {
		if err := f.cache.SaveUsage(repo, runID, usage); err != nil {
			logger.Debug("metrics: failed to cache usage", "run_id", runID, "error", err)
		}
	}
	return usage, nil
}
