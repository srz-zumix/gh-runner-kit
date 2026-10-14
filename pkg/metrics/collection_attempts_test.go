package metrics

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	ghclient "github.com/srz-zumix/go-gh-extension/pkg/gh/client"
)

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
	collector.SetAttemptJobFetcher(NewCachedAttemptJobFetcher(NewAPIAttemptJobFetcher(client), &Cache{base: t.TempDir()}, false))
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
	if metadataRequests.Load() != 4 || jobRequests.Load() != 1 {
		t.Fatalf("cached history still needs metadata: metadata=%d jobs=%d", metadataRequests.Load(), jobRequests.Load())
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, _, err := collector.collectHistoricalJobs(ctx, repository.Repository{Host: "github.com", Owner: "owner", Name: "repo"}, runs); err == nil {
		t.Fatal("cancellation was swallowed")
	}
}
