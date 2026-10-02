package kitutil

import (
	"context"
	"fmt"
	"strings"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
)

// ResolveRunTarget parses a workflow run reference and settles which repository and
// attempt it points at. A run URL names its own repository, which repoFlag may repeat
// but not contradict; a bare run ID takes the repository from repoFlag, or from the
// current directory when repoFlag is empty. attempt overrides the latest attempt, and
// must agree with the attempt a URL names.
func ResolveRunTarget(input, repoFlag string, attempt int) (repository.Repository, metrics.RunRef, error) {
	ref, err := metrics.ParseRunRef(input)
	if err != nil {
		return repository.Repository{}, metrics.RunRef{}, err
	}
	if attempt < 0 {
		return repository.Repository{}, metrics.RunRef{}, fmt.Errorf("--attempt must be a positive number, got %d", attempt)
	}
	if attempt > 0 {
		if ref.Attempt > 0 && ref.Attempt != attempt {
			return repository.Repository{}, metrics.RunRef{}, fmt.Errorf("--attempt %d conflicts with attempt %d in %q", attempt, ref.Attempt, input)
		}
		ref.Attempt = attempt
	}

	if ref.Repo == nil {
		repo, err := parser.Repository(parser.RepositoryInput(repoFlag))
		if err != nil {
			return repository.Repository{}, metrics.RunRef{}, fmt.Errorf("failed to resolve the repository of run %d: %w", ref.RunID, err)
		}
		return repo, ref, nil
	}

	repo := *ref.Repo
	if repoFlag != "" {
		flagRepo, err := parser.Repository(parser.RepositoryInput(repoFlag))
		if err != nil {
			return repository.Repository{}, metrics.RunRef{}, err
		}
		// OWNER/REPO takes the default host, so only a flag that spells out its host
		// is compared with the host of the URL.
		withHost := strings.Count(repoFlag, "/") == 2
		if !strings.EqualFold(flagRepo.Owner, repo.Owner) || !strings.EqualFold(flagRepo.Name, repo.Name) || (withHost && !strings.EqualFold(flagRepo.Host, repo.Host)) {
			return repository.Repository{}, metrics.RunRef{}, fmt.Errorf("--repo %s conflicts with the repository in %q", repoFlag, input)
		}
	}
	return repo, ref, nil
}

// FetchRunTimeline reads the attempt ref names and lays out its jobs and steps. The jobs
// of a completed attempt are cached on disk unless noCache is set, and refresh rewrites
// the cached entry from the API.
func FetchRunTimeline(ctx context.Context, repo repository.Repository, ref metrics.RunRef, opts metrics.TimelineOptions, noCache, refresh bool) (metrics.RunTimeline, error) {
	client, err := gh.NewGitHubClientWithRepo(repo)
	if err != nil {
		return metrics.RunTimeline{}, fmt.Errorf("failed to create a GitHub client: %w", err)
	}

	if ref.JobID != 0 && ref.Attempt <= 0 {
		attempt, err := metrics.FetchJobAttempt(ctx, client, repo, ref.RunID, ref.JobID)
		if err != nil {
			return metrics.RunTimeline{}, fmt.Errorf("failed to get job %d of workflow run %d: %w", ref.JobID, ref.RunID, err)
		}
		ref.Attempt = attempt
	}

	run, err := metrics.FetchRunAttempt(ctx, client, repo, ref.RunID, ref.Attempt)
	if err != nil {
		if ref.Attempt > 0 {
			return metrics.RunTimeline{}, fmt.Errorf("failed to get attempt %d of workflow run %d: %w", ref.Attempt, ref.RunID, err)
		}
		return metrics.RunTimeline{}, fmt.Errorf("failed to get workflow run %d: %w", ref.RunID, err)
	}

	fetcher := metrics.JobFetcher(metrics.NewAPIAttemptJobFetcher(client))
	if cache, ok := OpenMetricsCache(noCache); ok {
		fetcher = metrics.NewCachedAttemptJobFetcher(fetcher, cache, refresh)
	}
	jobs, err := fetcher.Jobs(ctx, repo, run)
	if err != nil {
		return metrics.RunTimeline{}, fmt.Errorf("failed to list the jobs of attempt %d of workflow run %d: %w", run.GetRunAttempt(), ref.RunID, err)
	}
	return metrics.BuildRunTimeline(repo, run, jobs, opts), nil
}
