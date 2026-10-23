package metrics

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v93/github"
	ghclient "github.com/srz-zumix/go-gh-extension/pkg/gh/client"
)

func TestHistoricalMetadataCacheModes(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		noCache  bool
		refresh  bool
		status   string
		requests int32
	}{
		{name: "completed", status: "completed", requests: 1},
		{name: "refresh", refresh: true, status: "completed", requests: 2},
		{name: "no cache", noCache: true, status: "completed", requests: 2},
		{name: "active", status: "in_progress", requests: 2},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path != "/repos/example/project/actions/runs/42/attempts/1" {
					t.Errorf("unexpected request: %s", r.URL)
				}
				_, _ = fmt.Fprintf(w, `{"id":42,"run_attempt":1,"status":%q}`, scenario.status)
			}))
			defer server.Close()
			base := server.URL + "/"
			api, err := github.NewClient(github.WithHTTPClient(server.Client()), github.WithURLs(&base, nil))
			if err != nil {
				t.Fatal(err)
			}
			client, err := ghclient.NewClient(api)
			if err != nil {
				t.Fatal(err)
			}
			directory := t.TempDir()
			repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
			for range 2 {
				collector := NewCollector(client, repo, Options{}, nil)
				if !scenario.noCache {
					collector.SetAttemptCache(&Cache{base: directory}, scenario.refresh)
				}
				run, _, err := collector.historicalRun(context.Background(), repo, 42, 1)
				if err != nil || run.GetID() != 42 || run.GetRunAttempt() != 1 {
					t.Fatalf("unexpected attempt: %v, error=%v", run, err)
				}
			}
			if requests.Load() != scenario.requests {
				t.Fatalf("metadata requests=%d, want %d", requests.Load(), scenario.requests)
			}
		})
	}
}

func TestHistoricalMetadataSurvivesJobRateLimit(t *testing.T) {
	var metadataRequests, jobRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/example/project/actions/runs/42/attempts/1":
			metadataRequests.Add(1)
			_, _ = fmt.Fprint(w, `{"id":42,"status":"completed","run_attempt":1}`)
		case "/repos/example/project/actions/runs/42/attempts/1/jobs":
			if jobRequests.Add(1) == 1 {
				w.Header().Set("X-RateLimit-Limit", "5000")
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("X-RateLimit-Reset", fmt.Sprint(time.Now().Add(time.Hour).Unix()))
				w.WriteHeader(http.StatusForbidden)
				_, _ = fmt.Fprint(w, `{"message":"API rate limit exceeded"}`)
				return
			}
			_, _ = fmt.Fprint(w, `{"total_count":1,"jobs":[{"id":101,"run_id":42,"run_attempt":1}]}`)
		default:
			t.Errorf("unexpected request: %s", r.URL)
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	base := server.URL + "/"
	directory := t.TempDir()
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	for attempt := range 3 {
		// A fresh API client must not retain the previous client's rate-limit state.
		api, err := github.NewClient(github.WithHTTPClient(server.Client()), github.WithURLs(&base, nil))
		if err != nil {
			t.Fatal(err)
		}
		client, err := ghclient.NewClient(api)
		if err != nil {
			t.Fatal(err)
		}
		var progress []CollectionProgress
		collector := NewCollector(client, repo, Options{OnProgress: func(record CollectionProgress) error {
			progress = append(progress, record)
			return nil
		}}, nil)
		cache := &Cache{base: directory}
		collector.SetAttemptCache(cache, false)
		collector.SetAttemptJobFetcher(NewCachedAttemptJobFetcher(NewAPIAttemptJobFetcher(client), cache, false))
		runs := []*github.WorkflowRun{{ID: github.Ptr(int64(42)), RunAttempt: github.Ptr(2)}}
		_, jobs, _, err := collector.collectHistoricalJobs(context.Background(), repo, runs)
		if attempt == 0 {
			if err == nil {
				t.Fatal("rate limit was swallowed")
			}
			if _, ok := cache.LoadRunAttempt(repo, 42, 1); !ok {
				t.Fatal("successful metadata was lost with the failed job listing")
			}
			continue
		}
		if err != nil || len(jobs) != 1 {
			t.Fatalf("resumed jobs=%v, error=%v", jobs, err)
		}
		if attempt == 1 {
			checkProgress(t, progress, "attempts", 1, 0, 1, 0)
		} else {
			checkProgress(t, progress, "attempts", 1, 1, 0, 0)
		}
	}
	if metadataRequests.Load() != 1 || jobRequests.Load() != 2 {
		t.Fatalf("recovery refetched completed data: metadata=%d jobs=%d", metadataRequests.Load(), jobRequests.Load())
	}
}

func TestHistoricalCollectionDedupAndMissingHistory(t *testing.T) {
	var metadataRequests, jobRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/owner/repo/actions/runs/42/attempts/1":
			metadataRequests.Add(1)
			_, _ = fmt.Fprint(w, `{"id":42,"status":"completed","run_attempt":1,"run_started_at":"2026-10-01T00:00:00Z"}`)
		case "/repos/owner/repo/actions/runs/42/attempts/1/jobs":
			jobRequests.Add(1)
			_, _ = fmt.Fprint(w, `{"total_count":2,"jobs":[{"id":101,"run_id":42,"run_attempt":1},{"id":102,"run_id":42,"run_attempt":1}]}`)
		case "/repos/owner/repo/actions/runs/42/attempts/2":
			metadataRequests.Add(1)
			w.WriteHeader(http.StatusNotFound)
			_, _ = fmt.Fprint(w, `{"message":"Not Found"}`)
		default:
			t.Errorf("unexpected historical request: %s", r.URL)
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	defer server.Close()
	base := server.URL + "/"
	api, err := github.NewClient(github.WithHTTPClient(server.Client()), github.WithURLs(&base, nil))
	if err != nil {
		t.Fatal(err)
	}
	client, err := ghclient.NewClient(api)
	if err != nil {
		t.Fatal(err)
	}
	var progress []CollectionProgress
	collector := NewCollector(client, repository.Repository{}, Options{Concurrency: 2, AllAttempts: true, OnProgress: func(record CollectionProgress) error {
		progress = append(progress, record)
		return nil
	}}, nil)
	cache := &Cache{base: t.TempDir()}
	collector.SetAttemptJobFetcher(NewCachedAttemptJobFetcher(NewAPIAttemptJobFetcher(client), cache, false))
	collector.SetAttemptCache(cache, false)
	runs := []*github.WorkflowRun{{ID: github.Ptr(int64(42)), RunAttempt: github.Ptr(3)}}
	attempts, jobs, warnings, err := collector.collectHistoricalJobs(context.Background(), repository.Repository{Host: "github.com", Owner: "owner", Name: "repo"}, runs)
	if err != nil || len(attempts) != 1 || len(jobs) != 2 || len(warnings) != 1 {
		t.Fatalf("unexpected history: attempts=%d jobs=%d warnings=%v err=%v", len(attempts), len(jobs), warnings, err)
	}
	checkProgress(t, progress, "attempts", 2, 0, 1, 1)
	latest := []*github.WorkflowJob{{ID: github.Ptr(int64(101)), RunAttempt: github.Ptr(int64(1))}, {ID: github.Ptr(int64(103)), RunAttempt: github.Ptr(int64(3))}}
	merged := mergeCollectedJobs(latest, jobs)
	if len(merged) != 3 || merged[0] != latest[0] || merged[2].GetID() != 102 {
		t.Fatalf("carried-over job was duplicated or real historical execution lost: %#v", merged)
	}
	progress = nil
	if _, _, _, err := collector.collectHistoricalJobs(context.Background(), repository.Repository{Host: "github.com", Owner: "owner", Name: "repo"}, runs); err != nil {
		t.Fatal(err)
	}
	checkProgress(t, progress, "attempts", 2, 1, 0, 1)
	if metadataRequests.Load() != 3 || jobRequests.Load() != 1 {
		t.Fatalf("completed metadata was refetched or missing history was cached: metadata=%d jobs=%d", metadataRequests.Load(), jobRequests.Load())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := collector.collectHistoricalJobs(ctx, repository.Repository{Host: "github.com", Owner: "owner", Name: "repo"}, runs); err == nil {
		t.Fatal("cancellation was swallowed")
	}
}
