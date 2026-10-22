package metrics

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	ghclient "github.com/srz-zumix/go-gh-extension/pkg/gh/client"
)

func TestCollectorRunPagesUseConfiguredConcurrency(t *testing.T) {
	for _, workflow := range []string{"", "build.yml"} {
		t.Run("workflow="+workflow, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			release := make(chan struct{})
			releaseAll := sync.OnceFunc(func() { close(release) })
			defer releaseAll()
			started := make(chan int, 3)
			start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				query := r.URL.Query()
				path := "/repos/example/project/actions/runs"
				if workflow != "" {
					path = "/repos/example/project/actions/workflows/build.yml/runs"
				}

				if r.URL.Path != path || query.Get("branch") != "feature" || query.Get("event") != "push" || query.Get("created") != "2026-10-01T00:00:00Z..2026-10-01T00:59:59Z" {
					t.Errorf("incorrect run search %s", r.URL)
				}
				page, _ := strconv.Atoi(query.Get("page"))
				page = max(1, page)
				if page > 1 {
					started <- page
					select {
					case <-release:
					case <-r.Context().Done():
						return
					}
				}
				w.Header().Set("Content-Type", "application/json")
				if page < 4 {
					w.Header().Set("Link", fmt.Sprintf(`<%s?page=%d>; rel="next", <%s?page=4>; rel="last"`, path, page+1, path))
				}
				var rows []*github.WorkflowRun
				for id := 350 - (page-1)*100; id > max(0, 350-page*100); id-- {
					rows = append(rows, runCreatedAt(int64(id), start.Add(time.Duration(id)*time.Second)))
				}
				if err := json.NewEncoder(w).Encode(map[string]any{"total_count": 350, "workflow_runs": rows}); err != nil {
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
				Window: Window{Start: start, End: start.Add(time.Hour)}, Concurrency: 3,
				Workflow: workflow, Branch: "feature", Event: "push",
			}, nil)
			type result struct {
				runs []*github.WorkflowRun
				err  error
			}
			done := make(chan result, 1)
			go func() {
				runs, _, err := collector.collectRuns(ctx, repository.Repository{Owner: "example", Name: "project"}, 0)
				done <- result{runs, err}
			}()
			for range 3 {
				select {
				case <-started:
				case <-ctx.Done():
					t.Fatal("collector did not use configured run-page concurrency")
				}
			}
			releaseAll()
			got := <-done
			if got.err != nil || len(got.runs) != 350 {
				t.Fatalf("runs=%d error=%v", len(got.runs), got.err)
			}
			for index, run := range got.runs {
				if run.GetID() != int64(350-index) {
					t.Fatalf("page ordering changed at row %d: ID=%d", index, run.GetID())
				}
			}
		})
	}
}

func TestCollectorCheckpointsRunDaysBeforeAPIFailure(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	day := now.Truncate(24 * time.Hour).Add(-5 * 24 * time.Hour)
	newer := day.Add(24 * time.Hour)
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	var mu sync.Mutex
	failOlder := true
	var queried []Window
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		bounds := strings.Split(query.Get("created"), "..")
		if len(bounds) != 2 || r.URL.Path != "/repos/example/project/actions/runs" {
			t.Errorf("unexpected run search %s", r.URL)
			http.Error(w, "unexpected search", http.StatusBadRequest)
			return
		}
		start, err := time.Parse(time.RFC3339, bounds[0])
		if err != nil {
			t.Error(err)
			return
		}
		end, err := time.Parse(time.RFC3339, bounds[1])
		if err != nil {
			t.Error(err)
			return
		}
		window := Window{Start: start, End: end.Add(time.Second)}
		mu.Lock()
		queried = append(queried, window)
		fail := failOlder && window.End.Equal(newer)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if fail {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"message":"synthetic older search failure"}`))
			return
		}
		var rows []*github.WorkflowRun
		for id := 1000; id > 0; id-- {
			index := id - 1
			at := day.Add(time.Duration(index/500)*24*time.Hour + time.Duration(index%500)*time.Minute)
			if window.Contains(at) {
				rows = append(rows, runCreatedAt(int64(id), at))
			}
		}
		page, _ := strconv.Atoi(query.Get("page"))
		page = max(1, page)
		total := len(rows)
		pages := max(1, (total+99)/100)
		if page < pages {
			w.Header().Set("Link", fmt.Sprintf(`<%s?page=%d>; rel="next", <%s?page=%d>; rel="last"`, r.URL.Path, page+1, r.URL.Path, pages))
		}
		from := min((page-1)*100, total)
		rows = rows[from:min(page*100, total)]
		if err := json.NewEncoder(w).Encode(map[string]any{"total_count": total, "workflow_runs": rows}); err != nil {
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
	var latest CollectionProgress
	collector := NewCollector(client, repo, Options{
		Window: Window{Start: day, End: newer.Add(24 * time.Hour)}, Concurrency: 3,
		OnProgress: func(progress CollectionProgress) error { latest = progress; return nil },
	}, nil)
	collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
	collector.runCache.now = func() time.Time { return now }
	if err := collector.progress.stage("runs", "example/project", "", 0); err != nil {
		t.Fatal(err)
	}
	if _, _, err := collector.collectRuns(t.Context(), repo, 0); err == nil {
		t.Fatal("older API failure was swallowed")
	}
	if rows, ok := collector.runCache.load(repo, newer, now); !ok || len(rows) != 500 {
		t.Fatal("collector did not checkpoint the completed day before the older API failure")
	}
	mu.Lock()
	failOlder = false
	queried = nil
	mu.Unlock()
	if err := collector.progress.stage("runs", "example/project", "", 0); err != nil {
		t.Fatal(err)
	}
	rows, truncated, err := collector.collectRuns(t.Context(), repo, 0)
	if err != nil || truncated || len(rows) != 1000 {
		t.Fatalf("resumed collector: rows=%d truncated=%v error=%v", len(rows), truncated, err)
	}
	for index, row := range rows {
		if row.GetID() != int64(1000-index) {
			t.Fatal("resumed collector lost or duplicated run IDs")
		}
	}
	if latest.RunSearch == nil || latest.RunSearch.CachedWindows != 1 || latest.RunSearch.Discovered != 1000 {
		t.Fatalf("incorrect resumed discovery telemetry: %+v", latest.RunSearch)
	}
	mu.Lock()
	defer mu.Unlock()
	for _, window := range queried {
		if window.End.After(newer) {
			t.Fatal("collector fetched the checkpointed day again")
		}
	}
}
