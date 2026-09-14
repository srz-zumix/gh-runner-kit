package metrics

import (
	"context"
	"testing"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

type countingUsageFetcher struct {
	calls int
	usage *github.WorkflowRunUsage
}

func (f *countingUsageFetcher) Usage(context.Context, repository.Repository, *github.WorkflowRun) (*github.WorkflowRunUsage, error) {
	f.calls++
	return f.usage, nil
}

func ubuntuUsageMS(usage *github.WorkflowRunUsage) int64 {
	return (*usage.GetBillable())["UBUNTU"].GetTotalMS()
}

func TestCachedUsageFetcherUsesCompletedRunCache(t *testing.T) {
	repo := repository.Repository{Host: "github.com", Owner: "o", Name: "r"}
	cache := &Cache{base: t.TempDir()}
	cached := usageWithBillable(1_000)
	if err := cache.SaveUsage(repo, 1, cached); err != nil {
		t.Fatalf("SaveUsage() error = %v", err)
	}
	inner := &countingUsageFetcher{usage: usageWithBillable(2_000)}
	fetcher := NewCachedUsageFetcher(inner, cache, false)

	got, err := fetcher.Usage(context.Background(), repo, &github.WorkflowRun{
		ID:     github.Ptr(int64(1)),
		Status: github.Ptr("completed"),
	})
	if err != nil {
		t.Fatalf("Usage() error = %v", err)
	}
	if inner.calls != 0 {
		t.Fatalf("inner calls = %d, want 0", inner.calls)
	}
	if ubuntuUsageMS(got) != 1_000 {
		t.Fatalf("Usage() = %+v, want cached usage", got)
	}
}

func TestCachedUsageFetcherRefreshesCompletedRun(t *testing.T) {
	repo := repository.Repository{Host: "github.com", Owner: "o", Name: "r"}
	cache := &Cache{base: t.TempDir()}
	if err := cache.SaveUsage(repo, 1, usageWithBillable(1_000)); err != nil {
		t.Fatalf("SaveUsage() error = %v", err)
	}
	inner := &countingUsageFetcher{usage: usageWithBillable(2_000)}
	fetcher := NewCachedUsageFetcher(inner, cache, true)
	run := &github.WorkflowRun{ID: github.Ptr(int64(1)), Status: github.Ptr("completed")}

	got, err := fetcher.Usage(context.Background(), repo, run)
	if err != nil {
		t.Fatalf("Usage() error = %v", err)
	}
	if inner.calls != 1 || ubuntuUsageMS(got) != 2_000 {
		t.Fatalf("Usage() calls = %d, usage = %+v, want refreshed usage", inner.calls, got)
	}
	stored, ok := cache.LoadUsage(repo, 1)
	if !ok || ubuntuUsageMS(stored) != 2_000 {
		t.Fatalf("LoadUsage() = %+v, %v, want refreshed cache entry", stored, ok)
	}
}

func TestCachedUsageFetcherDoesNotCacheInProgressRun(t *testing.T) {
	repo := repository.Repository{Host: "github.com", Owner: "o", Name: "r"}
	cache := &Cache{base: t.TempDir()}
	inner := &countingUsageFetcher{usage: usageWithBillable(1_000)}
	fetcher := NewCachedUsageFetcher(inner, cache, false)
	run := &github.WorkflowRun{ID: github.Ptr(int64(1)), Status: github.Ptr("in_progress")}

	for range 2 {
		if _, err := fetcher.Usage(context.Background(), repo, run); err != nil {
			t.Fatalf("Usage() error = %v", err)
		}
	}
	if inner.calls != 2 {
		t.Fatalf("inner calls = %d, want 2", inner.calls)
	}
	if _, ok := cache.LoadUsage(repo, 1); ok {
		t.Fatal("LoadUsage() found an in-progress run, want a cache miss")
	}
}
