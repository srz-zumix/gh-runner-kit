package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v93/github"
	ghclient "github.com/srz-zumix/go-gh-extension/pkg/gh/client"
)

func completedProgressRun(id int64) *github.WorkflowRun {
	return &github.WorkflowRun{ID: github.Ptr(id), Status: github.Ptr("completed"), RunAttempt: github.Ptr(1)}
}

func checkProgress(t *testing.T, records []CollectionProgress, stage string, total, cached, fetched, skipped int) {
	t.Helper()
	if len(records) < 2 {
		t.Fatalf("expected initial and final progress, got %v", records)
	}
	last := records[len(records)-1]
	if last.Stage != stage || last.Total != total || last.Cached != cached || last.Fetched != fetched || last.Skipped != skipped || last.Completed != cached+fetched+skipped {
		t.Fatalf("unexpected final progress: %+v", last)
	}
	previous := 0
	for _, record := range records {
		if record.Completed < previous || record.Completed > record.Total || record.Completed != record.Cached+record.Fetched+record.Skipped {
			t.Fatalf("invalid counters: %+v after %d completed", record, previous)
		}
		previous = record.Completed
	}
}

func TestCollectionProgressCountsCacheAndSkippedJobs(t *testing.T) {
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	cache := &Cache{base: t.TempDir()}
	if err := cache.SaveJobs(repo, 1, 1, []*github.WorkflowJob{jobWithID(101)}); err != nil {
		t.Fatal(err)
	}
	inner := &stubJobFetcher{jobs: map[int64][]*github.WorkflowJob{2: {jobWithID(102)}}, errs: map[int64]error{3: statusError(http.StatusNotFound)}}
	var records []CollectionProgress
	c := NewCollector(nil, repo, Options{Concurrency: 2, OnProgress: func(progress CollectionProgress) error {
		records = append(records, progress)
		return nil
	}}, NewCachedJobFetcher(inner, cache, false))
	jobs, warnings, err := c.collectJobs(context.Background(), repo, []*github.WorkflowRun{completedProgressRun(1), completedProgressRun(2), completedProgressRun(3)})
	if err != nil || len(jobs) != 2 || len(warnings) != 1 {
		t.Fatalf("jobs=%d warnings=%v error=%v", len(jobs), warnings, err)
	}
	checkProgress(t, records, "jobs", 3, 1, 1, 1)
}

func TestCollectionProgressFlushesBeforeRateLimitFailure(t *testing.T) {
	repo := repository.Repository{Owner: "example", Name: "project"}
	rateErr := &github.RateLimitError{Rate: github.Rate{Reset: github.Timestamp{Time: time.Now().Add(time.Hour)}}}
	var records []CollectionProgress
	c := NewCollector(nil, repo, Options{Concurrency: 1, OnProgress: func(progress CollectionProgress) error {
		records = append(records, progress)
		return nil
	}}, &stubJobFetcher{jobs: map[int64][]*github.WorkflowJob{1: {jobWithID(101)}}, errs: map[int64]error{2: rateErr}})
	_, _, err := c.collectJobs(context.Background(), repo, []*github.WorkflowRun{completedProgressRun(1), completedProgressRun(2)})
	if !errors.Is(err, rateErr) {
		t.Fatalf("got %v, want rate limit", err)
	}
	checkProgress(t, records, "jobs", 2, 0, 1, 0)
}

func TestCollectionProgressSerializesConcurrentCacheHits(t *testing.T) {
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	cache := &Cache{base: t.TempDir()}
	inner := &stubJobFetcher{jobs: make(map[int64][]*github.WorkflowJob)}
	var runs []*github.WorkflowRun
	for id := int64(1); id <= 64; id++ {
		runs = append(runs, completedProgressRun(id))
		inner.jobs[id] = []*github.WorkflowJob{jobWithID(1000 + id)}
		if id <= 32 {
			if err := cache.SaveJobs(repo, id, 1, inner.jobs[id]); err != nil {
				t.Fatal(err)
			}
		}
	}
	var records []CollectionProgress
	c := NewCollector(nil, repo, Options{Concurrency: 20, OnProgress: func(progress CollectionProgress) error {
		records = append(records, progress)
		return nil
	}}, NewCachedJobFetcher(inner, cache, false))
	if _, _, err := c.collectJobs(context.Background(), repo, runs); err != nil {
		t.Fatal(err)
	}
	checkProgress(t, records, "jobs", 64, 32, 32, 0)
	records = nil
	if _, _, err := c.collectJobs(context.Background(), repo, runs); err != nil {
		t.Fatal(err)
	}
	checkProgress(t, records, "jobs", 64, 64, 0, 0)
}

func TestCollectionProgressReportsUsageAndWriterErrors(t *testing.T) {
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	cache := &Cache{base: t.TempDir()}
	if err := cache.SaveUsage(repo, 1, 1, usageWithBillable(1000)); err != nil {
		t.Fatal(err)
	}
	var records []CollectionProgress
	c := NewCollector(nil, repo, Options{Concurrency: 1, OnProgress: func(progress CollectionProgress) error {
		records = append(records, progress)
		return nil
	}}, nil)
	c.SetUsageFetcher(NewCachedUsageFetcher(&countingUsageFetcher{usage: usageWithBillable(2000)}, cache, false))
	if _, _, err := c.collectUsage(context.Background(), repo, []*github.WorkflowRun{completedProgressRun(1), completedProgressRun(2)}); err != nil {
		t.Fatal(err)
	}
	checkProgress(t, records, "usage", 2, 1, 1, 0)
	want := errors.New("example writer failure")
	c = NewCollector(nil, repo, Options{OnProgress: func(CollectionProgress) error { return want }}, nil)
	if _, _, err := c.collectJobs(context.Background(), repo, nil); !errors.Is(err, want) {
		t.Fatalf("writer error was lost: %v", err)
	}
	c = NewCollector(nil, repo, Options{OnProgress: func(progress CollectionProgress) error {
		if progress.Completed > 0 {
			return want
		}
		return nil
	}}, &stubJobFetcher{jobs: map[int64][]*github.WorkflowJob{1: {jobWithID(101)}}})
	if _, _, err := c.collectJobs(context.Background(), repo, []*github.WorkflowRun{completedProgressRun(1)}); !errors.Is(err, want) {
		t.Fatalf("parallel progress callback error was lost: %v", err)
	}
}

func TestCollectionProgressEmptyStage(t *testing.T) {
	var records []CollectionProgress
	c := NewCollector(nil, repository.Repository{}, Options{OnProgress: func(progress CollectionProgress) error {
		records = append(records, progress)
		return nil
	}}, nil)
	if _, _, err := c.collectJobs(context.Background(), repository.Repository{}, nil); err != nil {
		t.Fatal(err)
	}
	checkProgress(t, records, "jobs", 0, 0, 0, 0)
}

func TestCacheProgressRefreshAndActiveRuns(t *testing.T) {
	repo := repository.Repository{Owner: "example", Name: "project"}
	for _, scenario := range []struct {
		name    string
		status  string
		refresh bool
		cached  bool
	}{
		{name: "completed cache hit", status: "completed", cached: true},
		{name: "active run ignores cached results", status: "in_progress"},
		{name: "refresh bypasses cached results", status: "completed", refresh: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			cache := &Cache{base: t.TempDir()}
			if err := cache.SaveJobs(repo, 1, 1, []*github.WorkflowJob{jobWithID(101)}); err != nil {
				t.Fatal(err)
			}
			if err := cache.SaveUsage(repo, 1, 1, usageWithBillable(1000)); err != nil {
				t.Fatal(err)
			}
			run := completedProgressRun(1)
			run.Status = github.Ptr(scenario.status)
			jobs := NewCachedJobFetcher(&stubJobFetcher{jobs: map[int64][]*github.WorkflowJob{1: {jobWithID(102)}}}, cache, scenario.refresh)
			rows, cached, err := jobs.JobsWithCache(context.Background(), repo, run)
			if err != nil || cached != scenario.cached || len(rows) != 1 {
				t.Fatalf("job cache status: cached=%v rows=%v error=%v", cached, rows, err)
			}
			usage := NewCachedUsageFetcher(&countingUsageFetcher{usage: usageWithBillable(2000)}, cache, scenario.refresh)
			if _, cached, err := usage.UsageWithCache(context.Background(), repo, run); err != nil || cached != scenario.cached {
				t.Fatalf("usage cache status: cached=%v error=%v", cached, err)
			}
		})
	}
}

func TestCollectionProgressRepositoryStagesAndUnknownRunTotal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path != "/repos/example/first/actions/runs" && r.URL.Path != "/repos/example/second/actions/runs" {
			t.Errorf("unexpected request %s", r.URL)
		}
		id := "1"
		if r.URL.Path == "/repos/example/second/actions/runs" {
			id = "2"
		}
		_, _ = w.Write([]byte(`{"workflow_runs":[{"id":` + id + `,"created_at":"2026-10-01T01:00:00Z"}]}`))
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
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	var records []CollectionProgress
	c := NewCollector(client, repository.Repository{}, Options{
		Repos:  []repository.Repository{{Owner: "example", Name: "first"}, {Owner: "example", Name: "second"}},
		Window: Window{Start: start, End: start.Add(24 * time.Hour)}, SkipJobs: true, SkipRunners: true,
		OnProgress: func(progress CollectionProgress) error { records = append(records, progress); return nil },
	}, nil)
	data, err := c.Collect(context.Background())
	if err != nil || len(data.Runs) != 2 {
		t.Fatalf("collection failed: data=%v error=%v", data, err)
	}
	var stages []string
	for _, record := range records {
		stages = append(stages, record.Stage)
		if record.Stage == "runs" && (record.Unit != "" || record.Total != 0 || record.RepositoriesTotal != 2) {
			t.Fatalf("run discovery claimed a known total: %+v", record)
		}
	}
	if !reflect.DeepEqual(stages, []string{"inventory", "repositories", "runs", "runs", "runs", "runs", "runs", "runs", "complete"}) {
		t.Fatalf("unexpected stages %v", stages)
	}
	for _, index := range []int{4, 7} {
		search := records[index].RunSearch
		if search == nil || search.Searches != 1 || search.Discovered != 1 || search.Created != "2026-10-01T00:00:00Z..2026-10-01T23:59:59Z" {
			t.Fatalf("incorrect repository search progress: %+v", search)
		}
	}
	last := records[len(records)-1]
	if last.RepositoryIndex != 2 || last.Runs != 2 || last.Jobs != 0 || last.RunSearch != nil {
		t.Fatalf("invalid completion %+v", last)
	}
}

func TestCollectionProgressRunSearchesDeduplicateSplitWindows(t *testing.T) {
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	window := Window{Start: start, End: start.Add(time.Hour)}
	var records []CollectionProgress
	var mu sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		created := r.URL.Query().Get("created")
		mu.Lock()
		search := records[len(records)-1].RunSearch
		mu.Unlock()
		if search == nil || search.Created != created {
			t.Errorf("request started before its progress update: %+v", search)
		}
		bounds := strings.Split(created, "..")
		from, err := time.Parse(time.RFC3339, bounds[0])
		if err != nil {
			t.Error(err)
			return
		}
		to, err := time.Parse(time.RFC3339, bounds[1])
		if err != nil {
			t.Error(err)
			return
		}
		var rows []*github.WorkflowRun
		for i := 1999; i >= 0; i-- {
			at := start.Add(time.Duration(i) * time.Second)
			if !at.Before(from) && !at.After(to) {
				rows = append(rows, runCreatedAt(int64(i+1), at))
			}
		}
		if len(rows) > workflowRunSearchCap {
			rows = rows[:workflowRunSearchCap]
		}
		if err := json.NewEncoder(w).Encode(map[string]any{"workflow_runs": rows}); err != nil {
			t.Error(err)
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
	collector := NewCollector(client, repository.Repository{}, Options{
		Window: window,
		OnProgress: func(progress CollectionProgress) error {
			mu.Lock()
			defer mu.Unlock()
			records = append(records, progress)
			return nil
		},
	}, nil)
	if err := collector.progress.stage("runs", "example/project", "", 0); err != nil {
		t.Fatal(err)
	}
	runs, truncated, err := collector.collectRuns(context.Background(), repository.Repository{Owner: "example", Name: "project"}, 0)
	if err != nil || truncated || len(runs) != 2000 {
		t.Fatalf("runs=%d truncated=%v error=%v", len(runs), truncated, err)
	}
	last := records[len(records)-1].RunSearch
	if last.Searches < 3 || last.Discovered != len(runs) {
		t.Fatalf("split searches double-counted runs: %+v", last)
	}
	previous := 0
	for index, record := range records[1:] {
		if record.Total != 0 || record.Completed != 0 || record.Unit != "" || record.RunSearch.Discovered < previous {
			t.Fatalf("invalid unknown-total search progress: %+v", record)
		}
		if record.RunSearch.Searches != index/2+1 {
			t.Fatalf("incorrect search ordinal: %+v", record.RunSearch)
		}
		previous = record.RunSearch.Discovered
	}
	if records[1].RunSearch.Discovered != 0 {
		t.Fatal("later updates mutated an earlier search record")
	}
}

func TestCollectionProgressRunSearchFailures(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusForbidden} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"workflow_runs":[]}`))
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
			start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
			var records []CollectionProgress
			collector := NewCollector(client, repository.Repository{}, Options{
				Window: Window{Start: start, End: start.Add(time.Hour)},
				OnProgress: func(progress CollectionProgress) error {
					records = append(records, progress)
					return nil
				},
			}, nil)
			_, _, err = collector.collectRuns(context.Background(), repository.Repository{Owner: "example", Name: "project"}, 0)
			want := 2
			if status == http.StatusForbidden {
				want = 1
			}
			if (err != nil) != (status == http.StatusForbidden) || len(records) != want || records[0].RunSearch.Discovered != 0 {
				t.Fatalf("empty/failed search progress: records=%+v error=%v", records, err)
			}
		})
	}
	want := errors.New("example progress failure")
	collector := NewCollector(nil, repository.Repository{}, Options{
		Window: Window{Start: time.Now().Add(-time.Hour), End: time.Now()},
		OnProgress: func(CollectionProgress) error {
			return want
		},
	}, nil)
	if _, _, err := collector.collectRuns(context.Background(), repository.Repository{}, 0); !errors.Is(err, want) {
		t.Fatalf("search progress failure was swallowed: %v", err)
	}
}
