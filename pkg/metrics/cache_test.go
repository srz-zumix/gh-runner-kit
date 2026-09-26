package metrics

import (
	"path/filepath"
	"testing"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

// TestCacheIsolatesRepositories makes sure entries sharing a run ID but belonging to
// different repositories never collide, even when the same Cache serves every repo.
func TestCacheIsolatesRepositories(t *testing.T) {
	cache := &Cache{base: t.TempDir()}

	repoA := repository.Repository{Host: "github.com", Owner: "octo", Name: "alpha"}
	repoB := repository.Repository{Host: "github.com", Owner: "octo", Name: "beta"}
	const runID int64 = 42

	jobsA := []*github.WorkflowJob{{Name: github.Ptr("build-alpha")}}
	jobsB := []*github.WorkflowJob{{Name: github.Ptr("build-beta")}}

	if err := cache.SaveJobs(repoA, runID, 1, jobsA); err != nil {
		t.Fatalf("SaveJobs repoA: %v", err)
	}
	if err := cache.SaveJobs(repoB, runID, 1, jobsB); err != nil {
		t.Fatalf("SaveJobs repoB: %v", err)
	}

	gotA, ok := cache.LoadJobs(repoA, runID, 1)
	if !ok || len(gotA) != 1 || gotA[0].GetName() != "build-alpha" {
		t.Fatalf("LoadJobs repoA = %v, ok=%v; want build-alpha", gotA, ok)
	}
	gotB, ok := cache.LoadJobs(repoB, runID, 1)
	if !ok || len(gotB) != 1 || gotB[0].GetName() != "build-beta" {
		t.Fatalf("LoadJobs repoB = %v, ok=%v; want build-beta", gotB, ok)
	}
}

// TestCacheMissForUnknownRepo confirms a lookup returns absent when nothing was stored.
func TestCacheMissForUnknownRepo(t *testing.T) {
	cache := &Cache{base: t.TempDir()}

	repo := repository.Repository{Host: "github.com", Owner: "octo", Name: "alpha"}
	if _, ok := cache.LoadJobs(repo, 7, 1); ok {
		t.Fatal("LoadJobs returned present for an empty cache")
	}
}

// TestCacheSeparatesRunAttempts makes sure a re-run is not answered with the jobs of the
// attempt before it, while the first attempt keeps the entry name used before attempts
// were told apart.
func TestCacheSeparatesRunAttempts(t *testing.T) {
	cache := &Cache{base: t.TempDir()}
	repo := repository.Repository{Host: "github.com", Owner: "octo", Name: "alpha"}
	const runID int64 = 42

	if err := cache.SaveJobs(repo, runID, 1, []*github.WorkflowJob{{Name: github.Ptr("first")}}); err != nil {
		t.Fatalf("SaveJobs attempt 1: %v", err)
	}
	if _, ok := cache.LoadJobs(repo, runID, 2); ok {
		t.Fatal("LoadJobs attempt 2 returned the entry of attempt 1")
	}
	if err := cache.SaveJobs(repo, runID, 2, []*github.WorkflowJob{{Name: github.Ptr("second")}}); err != nil {
		t.Fatalf("SaveJobs attempt 2: %v", err)
	}

	first, ok := cache.LoadJobs(repo, runID, 1)
	if !ok || len(first) != 1 || first[0].GetName() != "first" {
		t.Fatalf("LoadJobs attempt 1 = %v, ok=%v; want first", first, ok)
	}
	second, ok := cache.LoadJobs(repo, runID, 2)
	if !ok || len(second) != 1 || second[0].GetName() != "second" {
		t.Fatalf("LoadJobs attempt 2 = %v, ok=%v; want second", second, ok)
	}
	// A run whose attempt the API did not report reads the first attempt's entry.
	if _, ok := cache.LoadJobs(repo, runID, 0); !ok {
		t.Fatal("LoadJobs attempt 0 missed the first attempt's entry")
	}
	if got := filepath.Base(cache.path(repo, jobsKind, runID, 1)); got != "42.json" {
		t.Fatalf("path of attempt 1 = %s, want 42.json", got)
	}
}
