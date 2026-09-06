package runnergroup

import (
	"context"
	"fmt"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
)

// Organization resolves the organization to operate on and returns a client for it.
func Organization(ownerFlag, repoFlag string) (repository.Repository, *gh.GitHubClient, error) {
	repo, err := parser.Repository(
		parser.RepositoryOwnerWithHost(ownerFlag),
		parser.RepositoryInput(repoFlag),
	)
	if err != nil {
		return repo, nil, err
	}

	client, err := gh.NewGitHubClientWithRepo(repo)
	if err != nil {
		return repo, nil, err
	}
	return repo, client, nil
}

// Find resolves the runner group selected by name or ID, failing when it does not exist.
func Find(ctx context.Context, client *gh.GitHubClient, repo repository.Repository, selector string) (*github.RunnerGroup, error) {
	group, err := gh.FindOrgRunnerGroupByNameOrID(ctx, client, repo, selector)
	if err != nil {
		return nil, fmt.Errorf("failed to find runner group %q in %s: %w", selector, repo.Owner, err)
	}
	if group == nil {
		return nil, fmt.Errorf("runner group %q not found in %s", selector, repo.Owner)
	}
	return group, nil
}

// FindRunner resolves the organization runner selected by name or ID, failing when it does not exist.
func FindRunner(ctx context.Context, client *gh.GitHubClient, repo repository.Repository, selector string) (*github.Runner, error) {
	runner, err := gh.FindOrgRunnerByNameOrID(ctx, client, repo, selector)
	if err != nil {
		return nil, fmt.Errorf("failed to find runner %q in %s: %w", selector, repo.Owner, err)
	}
	if runner == nil {
		return nil, fmt.Errorf("runner %q not found in %s", selector, repo.Owner)
	}
	return runner, nil
}
