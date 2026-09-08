package metrics

import (
	"testing"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

// TestCacheIsolatesRepositories makes sure entries sharing a run ID but belonging to
// different repositories never collide, even when the same Cache serves every repo.
func TestCacheIsolatesRepositories(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CACHE_HOME", dir)

	cache, err := NewCache()
	if err != nil {
		t.Fatalf("NewCache: %v", err)
	}

	repoA := repository.Repository{Host: "github.com", Owner: "octo", Name: "alpha"}
	repoB := repository.Repository{Host: "github.com", Owner: "octo", Name: "beta"}
	const runID int64 = 42

	jobsA := []*github.WorkflowJob{{Name: github.Ptr("build-alpha")}}
	jobsB := []*github.WorkflowJob{{Name: github.Ptr("build-beta")}}

	if err := cache.SaveJobs(repoA, runID, jobsA); err != nil {
		t.Fatalf("SaveJobs repoA: %v", err)
	}
	if err := cache.SaveJobs(repoB, runID, jobsB); err != nil {
		t.Fatalf("SaveJobs repoB: %v", err)
	}

	gotA, ok := cache.LoadJobs(repoA, runID)
	if !ok || len(gotA) != 1 || gotA[0].GetName() != "build-alpha" {
		t.Fatalf("LoadJobs repoA = %v, ok=%v; want build-alpha", gotA, ok)
	}
	gotB, ok := cache.LoadJobs(repoB, runID)
	if !ok || len(gotB) != 1 || gotB[0].GetName() != "build-beta" {
		t.Fatalf("LoadJobs repoB = %v, ok=%v; want build-beta", gotB, ok)
	}
}

// TestCacheMissForUnknownRepo confirms a lookup returns absent when nothing was stored.
func TestCacheMissForUnknownRepo(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CACHE_HOME", dir)

	cache, err := NewCache()
	if err != nil {
		t.Fatalf("NewCache: %v", err)
	}

	repo := repository.Repository{Host: "github.com", Owner: "octo", Name: "alpha"}
	if _, ok := cache.LoadJobs(repo, 7); ok {
		t.Fatal("LoadJobs returned present for an empty cache")
	}
}
