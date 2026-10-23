package metrics

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v93/github"
)

func TestRunListingCacheMovingWindowAndFreshness(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	collector := NewCollector(nil, repo, Options{}, nil)
	collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
	cache := collector.runCache
	cache.now = func() time.Time { return now }
	window := Window{Start: now.Add(-5 * 24 * time.Hour), End: now}
	var source []*github.WorkflowRun
	for i := range 120 {
		source = append(source, runCreatedAt(int64(i+1), window.Start.Add(time.Duration(i)*time.Hour)))
	}
	slices.Reverse(source)
	var queries []Window
	var hits []Window
	list := func(w Window, budget int, _ *runWindowCheckpoint) ([]*github.WorkflowRun, error) {
		queries = append(queries, w)
		var rows []*github.WorkflowRun
		for _, run := range source {
			if w.Contains(run.GetCreatedAt().Time) {
				rows = append(rows, run)
			}
		}
		if budget > 0 && len(rows) > budget {
			rows = rows[:budget]
		}
		return rows, nil
	}
	hit := func(w Window, _ []*github.WorkflowRun) error { hits = append(hits, w); return nil }
	read := func(w Window, budget int) []*github.WorkflowRun {
		t.Helper()
		queries, hits = nil, nil
		rows, err := cache.collect(context.Background(), repo, w, budget, list, hit)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	if got := read(window, 0); len(got) != 120 || len(queries) != 1 || len(hits) != 0 {
		t.Fatalf("cold collection: rows=%d queries=%v hits=%v", len(got), queries, hits)
	}
	old := source[80]
	oldID := old.GetID()
	source[80] = &github.WorkflowRun{ID: github.Ptr(oldID), CreatedAt: old.CreatedAt, RunAttempt: github.Ptr(2)}
	newRun := runCreatedAt(9007199254740993, now.Add(-time.Minute))
	source = append([]*github.WorkflowRun{newRun}, source...)
	recentDeleted := source[5].GetID()
	source = slices.Delete(source, 5, 6)
	now = now.Add(5 * time.Minute)
	moving := Window{Start: window.Start.Add(5 * time.Minute), End: now}
	got := read(moving, 0)
	if len(queries) != 2 || len(hits) != 3 || len(got) != 119 || got[0].GetID() != newRun.GetID() {
		t.Fatalf("warm moving window: rows=%d queries=%v hits=%v", len(got), queries, hits)
	}
	for _, run := range got {
		if !moving.Contains(run.GetCreatedAt().Time) || run.GetID() == recentDeleted {
			t.Fatal("recent deletion or exact moving boundary was ignored")
		}
		if run.GetID() == oldID && run.GetRunAttempt() == 2 {
			t.Fatal("historical row unexpectedly bypassed its valid cache")
		}
	}
	for _, budget := range []int{1, 30, 50, 90, 119, 200} {
		rows := read(moving, budget)
		want := min(budget, len(got))
		if len(rows) != want {
			t.Fatalf("budget %d returned %d rows, want %d", budget, len(rows), want)
		}
		for i := range rows {
			if rows[i].GetID() != got[i].GetID() {
				t.Fatalf("budget %d changed newest-first ordering", budget)
			}
		}
	}
	now = now.Add(55 * time.Minute)
	got = read(moving, 0)
	if len(hits) != 0 || len(queries) != 1 {
		t.Fatalf("one-hour expiry was ignored: queries=%v hits=%v", queries, hits)
	}
	if !slices.ContainsFunc(got, func(run *github.WorkflowRun) bool { return run.GetID() == oldID && run.GetRunAttempt() == 2 }) {
		t.Fatal("expired cache hid the historical rerun")
	}
	cache.refresh = true
	read(moving, 0)
	if len(hits) != 0 || len(queries) != 1 {
		t.Fatal("refresh did not bypass every listing cache")
	}
	cache.refresh = false
	read(moving, 0)
	if len(hits) != 3 {
		t.Fatal("refresh did not replace reusable historical days")
	}
}

func TestRunListingCacheNeverSavesIncompleteDay(t *testing.T) {
	now := time.Date(2026, 10, 20, 0, 0, 0, 0, time.UTC)
	day := now.Add(-3 * 24 * time.Hour)
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	collector := NewCollector(nil, repo, Options{}, nil)
	collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
	cache := collector.runCache
	cache.now = func() time.Time { return now }
	window := Window{Start: day, End: day.Add(24 * time.Hour)}
	source := []*github.WorkflowRun{runCreatedAt(2, day.Add(2*time.Hour)), runCreatedAt(1, day.Add(time.Hour))}
	calls, hits := 0, 0
	list := func(_ Window, budget int, _ *runWindowCheckpoint) ([]*github.WorkflowRun, error) {
		calls++
		if budget > 0 {
			return source[:budget], nil
		}
		return slices.Clone(source), nil
	}
	hit := func(Window, []*github.WorkflowRun) error { hits++; return nil }
	for _, budget := range []int{1, 0, 0} {
		rows, err := cache.collect(context.Background(), repo, window, budget, list, hit)
		if err != nil || len(rows) != map[int]int{1: 1, 0: 2}[budget] {
			t.Fatalf("budget=%d: rows=%v error=%v", budget, rows, err)
		}
	}
	if calls != 2 || hits != 1 {
		t.Fatalf("a capped prefix poisoned a full-day listing: calls=%d hits=%d", calls, hits)
	}
}

func TestRunListingCacheExpiresDuringDiscovery(t *testing.T) {
	now := time.Now().UTC()
	window := Window{Start: now.Add(-5 * 24 * time.Hour), End: now}
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	collector := NewCollector(nil, repo, Options{}, nil)
	collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
	cache := collector.runCache
	cache.now = func() time.Time { return now }
	cache.saveDays(repo, window, now.Add(-runListingFreshAge), now, nil, 0, nil)
	now = now.Add(10 * time.Minute)
	calls, hits := 0, 0
	_, err := cache.collect(context.Background(), repo, window, 0, func(Window, int, *runWindowCheckpoint) ([]*github.WorkflowRun, error) {
		calls++
		if calls == 1 {
			now = now.Add(time.Hour)
		}
		return nil, nil
	}, func(Window, []*github.WorkflowRun) error { hits++; return nil })
	if err != nil || calls != 2 || hits != 0 {
		t.Fatalf("entries expiring during the fresh search were not refetched together: calls=%d hits=%d error=%v", calls, hits, err)
	}
}

func TestRunListingCacheRetainsCoverageBeyondSearchCap(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	window := Window{Start: now.Add(-10 * 24 * time.Hour), End: now}
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	collector := NewCollector(nil, repo, Options{}, nil)
	collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
	cache := collector.runCache
	cache.now = func() time.Time { return now }
	source := make([]*github.WorkflowRun, 7001)
	for i := range source {
		source[i] = runCreatedAt(int64(i+1), window.Start.Add(time.Duration(i)*2*time.Minute))
	}
	slices.Reverse(source)
	calls, hits := 0, 0
	list := func(w Window, budget int, checkpoint *runWindowCheckpoint) ([]*github.WorkflowRun, error) {
		return collectWindowRuns(context.Background(), w, budget, func(created string, cap int) ([]*github.WorkflowRun, error) {
			calls++
			bounds := strings.Split(created, "..")
			start, err := time.Parse(time.RFC3339, bounds[0])
			if err != nil {
				t.Fatal(err)
			}
			end, err := time.Parse(time.RFC3339, bounds[1])
			if err != nil {
				t.Fatal(err)
			}
			var rows []*github.WorkflowRun
			for _, run := range source {
				if at := run.GetCreatedAt().Time; !at.Before(start) && !at.After(end) {
					rows = append(rows, run)
				}
			}
			if len(rows) > cap {
				rows = rows[:cap]
			}
			return rows, nil
		}, checkpoint)
	}
	hit := func(Window, []*github.WorkflowRun) error { hits++; return nil }
	cold, err := cache.collect(context.Background(), repo, window, 0, list, hit)
	if err != nil || len(cold) != len(source) {
		t.Fatalf("cold coverage: rows=%d error=%v", len(cold), err)
	}
	coldCalls := calls
	now = now.Add(5 * time.Minute)
	window.Start = window.Start.Add(5 * time.Minute)
	window.End = now
	calls = 0
	warm, err := cache.collect(context.Background(), repo, window, 0, list, hit)
	if err != nil || hits != 8 || calls*2 >= coldCalls {
		t.Fatalf("warm discovery did not skip historical searches: cold=%d warm=%d hits=%d error=%v", coldCalls, calls, hits, err)
	}
	warmCalls := calls
	fresh, err := list(window, 0, nil)
	if err != nil || !slices.EqualFunc(warm, fresh, func(a, b *github.WorkflowRun) bool { return a.GetID() == b.GetID() }) {
		t.Fatal("warm discovery lost or duplicated runs across saturated or moving windows")
	}
	t.Logf("synthetic 7,001-run discovery: cold=%d searches, warm=%d searches", coldCalls, warmCalls)
}

func TestCachedRunDiscoveryProgressAndCancellation(t *testing.T) {
	now := time.Now().UTC()
	day := now.Truncate(24 * time.Hour).Add(-3 * 24 * time.Hour)
	window := Window{Start: day, End: day.Add(24 * time.Hour)}
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	var records []CollectionProgress
	collector := NewCollector(nil, repo, Options{Window: window, OnProgress: func(p CollectionProgress) error {
		records = append(records, p)
		return nil
	}}, nil)
	collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
	collector.runCache.saveDays(repo, window, now.Add(-runListingFreshAge), now, []*github.WorkflowRun{runCreatedAt(9007199254740993, day)}, 0, nil)
	if err := collector.progress.stage("runs", "example/project", "", 0); err != nil {
		t.Fatal(err)
	}
	rows, truncated, err := collector.collectRuns(context.Background(), repo, 0)
	if err != nil || truncated || len(rows) != 1 || rows[0].GetID() != 9007199254740993 {
		t.Fatalf("cached discovery unexpectedly needed an API client: rows=%v truncated=%v error=%v", rows, truncated, err)
	}
	progress := records[len(records)-1].RunSearch
	if progress == nil || progress.Searches != 0 || progress.CachedWindows != 1 || progress.Discovered != 1 {
		t.Fatalf("incorrect cache-only discovery telemetry: %+v", progress)
	}
	failure := errors.New("synthetic progress failure")
	collector.progress.callback = func(CollectionProgress) error { return failure }
	if _, _, err := collector.collectRuns(context.Background(), repo, 0); !errors.Is(err, failure) {
		t.Fatal("cached discovery swallowed the progress callback failure")
	}
}

func TestRunListingCacheIsolationInvalidEntriesAndFailures(t *testing.T) {
	now := time.Now().UTC()
	day := now.Truncate(24 * time.Hour).Add(-3 * 24 * time.Hour)
	window := Window{Start: day, End: day.Add(24 * time.Hour)}
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	disk := &Cache{base: t.TempDir()}
	newCache := func(opts Options, token string) *runListingCache {
		c := NewCollector(nil, repo, opts, nil)
		c.SetRunCache(disk, false, token)
		c.runCache.now = func() time.Time { return now }
		return c.runCache
	}
	cache := newCache(Options{}, "fictional-token")
	calls, hits := 0, 0
	list := func(Window, int, *runWindowCheckpoint) ([]*github.WorkflowRun, error) {
		calls++
		return nil, nil
	}
	hit := func(Window, []*github.WorkflowRun) error { hits++; return nil }
	if _, err := cache.collect(context.Background(), repo, window, 0, list, hit); err != nil {
		t.Fatal(err)
	}
	for _, other := range []*runListingCache{
		newCache(Options{Branch: "feature/example"}, "fictional-token"),
		newCache(Options{Event: "push"}, "fictional-token"),
		newCache(Options{Workflow: "other.yml"}, "fictional-token"),
		newCache(Options{}, "other-fictional-token"),
	} {
		if _, err := other.collect(context.Background(), repo, window, 0, list, hit); err != nil {
			t.Fatal(err)
		}
	}
	for _, other := range []repository.Repository{
		{Host: "ghe.example.test", Owner: repo.Owner, Name: repo.Name},
		{Host: repo.Host, Owner: "other", Name: repo.Name},
		{Host: repo.Host, Owner: repo.Owner, Name: "other"},
	} {
		if _, err := cache.collect(context.Background(), other, window, 0, list, hit); err != nil {
			t.Fatal(err)
		}
	}
	if hits != 0 || calls != 8 {
		t.Fatalf("cache crossed credentials, filters or repository boundaries: calls=%d hits=%d", calls, hits)
	}
	if _, err := cache.collect(context.Background(), repo, window, 0, list, hit); err != nil || hits != 1 {
		t.Fatal("a fully cached historical window or empty day was not reused")
	}
	for _, invalid := range []string{"{", `{"version":1}`, `{} {}`} {
		if err := os.WriteFile(cache.path(repo, day), []byte(invalid), cacheFilePerm); err != nil {
			t.Fatal(err)
		}
		if _, ok := cache.load(repo, day, now); ok {
			t.Fatal("invalid cache entry was reused")
		}
	}
	failure := errors.New("synthetic API failure")
	_, err := cache.collect(context.Background(), repo, window, 0,
		func(Window, int, *runWindowCheckpoint) ([]*github.WorkflowRun, error) { return nil, failure }, hit)
	if !errors.Is(err, failure) {
		t.Fatal("API failure was hidden by a cache fallback")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cache.collect(ctx, repo, window, 0, list, hit); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation was ignored")
	}
	collector := NewCollector(nil, repo, Options{}, nil)
	collector.SetRunCache(nil, false, "")
	if collector.runCache != nil {
		t.Fatal("nil cache did not disable discovery caching")
	}
}

func runListingSearch(t *testing.T, ctx context.Context, source []*github.WorkflowRun, before func(Window) error) func(Window, int, *runWindowCheckpoint) ([]*github.WorkflowRun, error) {
	t.Helper()
	source = slices.Clone(source)
	slices.SortFunc(source, compareRunsNewestFirst)
	return func(window Window, budget int, checkpoint *runWindowCheckpoint) ([]*github.WorkflowRun, error) {
		return collectWindowRuns(ctx, window, budget, func(created string, cap int) ([]*github.WorkflowRun, error) {
			bounds := strings.Split(created, "..")
			start, err := time.Parse(time.RFC3339, bounds[0])
			if err != nil {
				t.Fatal(err)
			}
			end, err := time.Parse(time.RFC3339, bounds[1])
			if err != nil {
				t.Fatal(err)
			}
			covered := Window{Start: start, End: end.Add(time.Second)}
			if before != nil {
				if err := before(covered); err != nil {
					return nil, err
				}
			}
			var rows []*github.WorkflowRun
			for _, run := range source {
				if covered.Contains(run.GetCreatedAt().Time) {
					rows = append(rows, run)
					if len(rows) == cap {
						break
					}
				}
			}
			return rows, nil
		}, checkpoint)
	}
}

func TestRunListingCacheCheckpointsBeforeInterruptedOlderSearch(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		t.Run(map[bool]string{false: "API failure", true: "cancellation"}[canceled], func(t *testing.T) {
			now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
			day := now.Truncate(24 * time.Hour).Add(-5 * 24 * time.Hour)
			newer := day.Add(24 * time.Hour)
			window := Window{Start: day, End: newer.Add(24 * time.Hour)}
			repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
			collector := NewCollector(nil, repo, Options{}, nil)
			collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
			cache := collector.runCache
			cache.now = func() time.Time { return now }
			var source []*github.WorkflowRun
			for i := range 500 {
				source = append(source, runCreatedAt(int64(i+1), day.Add(time.Duration(i)*40*time.Second)))
			}
			for i := range 1500 {
				source = append(source, runCreatedAt(int64(i+501), newer.Add(time.Duration(i)*40*time.Second)))
			}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			failure := errors.New("synthetic older search failure")
			list := runListingSearch(t, ctx, source, func(w Window) error {
				if w.End.Equal(newer) {
					if canceled {
						cancel()
						return ctx.Err()
					}
					return failure
				}
				return nil
			})
			hit := func(Window, []*github.WorkflowRun) error { return nil }
			_, err := cache.collect(ctx, repo, window, 0, list, hit)
			want := failure
			if canceled {
				want = context.Canceled
			}
			if !errors.Is(err, want) {
				t.Fatalf("interrupted discovery error=%v, want %v", err, want)
			}
			rows, ok := cache.load(repo, newer, now)
			if !ok || len(rows) != 1500 {
				t.Fatalf("completed dense day was not checkpointed: rows=%d cached=%v", len(rows), ok)
			}
			for index, row := range rows {
				if row.GetID() != int64(2000-index) {
					t.Fatal("checkpoint lost, duplicated or reordered a dense day's runs")
				}
			}
			if _, ok := cache.load(repo, day, now); ok {
				t.Fatal("failed older day was cached")
			}
			hits, calls := 0, 0
			list = runListingSearch(t, t.Context(), source, func(w Window) error {
				calls++
				if w.End.After(newer) {
					t.Fatal("resumed discovery re-searched the checkpointed day")
				}
				return nil
			})
			rows, err = cache.collect(t.Context(), repo, window, 0, list, func(Window, []*github.WorkflowRun) error { hits++; return nil })
			if err != nil || hits != 1 || calls != 1 || len(rows) != len(source) {
				t.Fatalf("resumed discovery: rows=%d calls=%d hits=%d error=%v", len(rows), calls, hits, err)
			}
			for index, row := range rows {
				if row.GetID() != int64(2000-index) {
					t.Fatal("resumed discovery did not match complete uncached coverage")
				}
			}
		})
	}
}

func TestRunListingCacheDoesNotCheckpointPartialDenseDay(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	day := now.Truncate(24 * time.Hour).Add(-5 * 24 * time.Hour)
	window := Window{Start: day, End: day.Add(24 * time.Hour)}
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	var source []*github.WorkflowRun
	for i := range 1500 {
		source = append(source, runCreatedAt(int64(i+1), day.Add(time.Duration(i)*40*time.Second)))
	}
	for _, budget := range []int{0, 500, 1000, 1200} {
		t.Run(fmt.Sprint(budget), func(t *testing.T) {
			collector := NewCollector(nil, repo, Options{}, nil)
			collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
			cache := collector.runCache
			cache.now = func() time.Time { return now }
			failure := errors.New("synthetic incomplete day")
			list := runListingSearch(t, t.Context(), source, func(w Window) error {
				if budget == 0 && w.End.Equal(day.Add(12*time.Hour)) {
					return failure
				}
				return nil
			})
			_, err := cache.collect(t.Context(), repo, window, budget, list, func(Window, []*github.WorkflowRun) error { return nil })
			if (budget == 0 && !errors.Is(err, failure)) || (budget > 0 && err != nil) {
				t.Fatalf("partial discovery error: %v", err)
			}
			if _, err := os.Stat(cache.path(repo, day)); !os.IsNotExist(err) {
				t.Fatalf("incomplete day was written: %v", err)
			}
		})
	}
}

func TestRunListingCheckpointFreshnessUsesRetainedSearches(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	started := now
	day := now.Truncate(24 * time.Hour).Add(-6 * 24 * time.Hour)
	window := Window{Start: day, End: day.Add(3 * 24 * time.Hour)}
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	collector := NewCollector(nil, repo, Options{}, nil)
	collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
	cache := collector.runCache
	cache.now = func() time.Time { return now }
	var source []*github.WorkflowRun
	for d := range 3 {
		for i := range 500 {
			source = append(source, runCreatedAt(int64(d*500+i+1), day.Add(time.Duration(d)*24*time.Hour+time.Duration(i)*40*time.Second)))
		}
	}
	calls := 0
	list := runListingSearch(t, t.Context(), source, func(Window) error {
		calls++
		now = now.Add(20 * time.Minute)
		return nil
	})
	rows, err := cache.collect(t.Context(), repo, window, 0, list, func(Window, []*github.WorkflowRun) error { return nil })
	if err != nil || calls != 5 || len(rows) != len(source) {
		t.Fatalf("long discovery: rows=%d calls=%d error=%v", len(rows), calls, err)
	}
	if rows, ok := cache.load(repo, day, now); !ok || len(rows) != 500 {
		t.Fatal("late checkpoint expired from the discarded initial search timestamp")
	}
	for d, minute := range []int{80, 60, 40} {
		data, err := os.ReadFile(cache.path(repo, day.Add(time.Duration(d)*24*time.Hour)))
		if err != nil {
			t.Fatal(err)
		}
		var entry cachedRunDay
		if err := json.Unmarshal(data, &entry); err != nil {
			t.Fatal(err)
		}
		if !entry.CreatedAt.Equal(started.Add(time.Duration(minute) * time.Minute)) {
			t.Fatalf("day %d freshness was rewritten by an ancestor: %s", d, entry.CreatedAt)
		}
		if validCachedDay(entry, entry.Day, entry.CreatedAt.Add(time.Hour)) {
			t.Fatal("checkpoint extended the one-hour TTL")
		}
	}
}

func TestRunListingCheckpointsRespectPartialBoundaries(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	day := now.Truncate(24 * time.Hour).Add(-6 * 24 * time.Hour)
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	for _, days := range []int{1, 2, 3} {
		t.Run(fmt.Sprint(days), func(t *testing.T) {
			collector := NewCollector(nil, repo, Options{}, nil)
			collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
			cache := collector.runCache
			cache.now = func() time.Time { return now }
			window := Window{Start: day.Add(time.Second / 2), End: day.Add(time.Duration(days)*24*time.Hour - time.Second/2)}
			calls := 0
			list := runListingSearch(t, t.Context(), nil, func(Window) error { calls++; return nil })
			if _, err := cache.collect(t.Context(), repo, window, 0, list, func(Window, []*github.WorkflowRun) error { return nil }); err != nil {
				t.Fatal(err)
			}
			if calls != 1 {
				t.Fatalf("quiet cold discovery needed %d calls", calls)
			}
			for d := range days {
				_, ok := cache.load(repo, day.Add(time.Duration(d)*24*time.Hour), now)
				if ok != (d > 0 && d < days-1) {
					t.Fatalf("day %d partial boundary was rounded into complete coverage", d)
				}
			}
		})
	}
}

func TestRunListingCheckpointWriteFailurePreservesValidEntry(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	day := now.Truncate(24 * time.Hour).Add(-4 * 24 * time.Hour)
	window := Window{Start: day, End: day.Add(24 * time.Hour)}
	repo := repository.Repository{Host: "github.com", Owner: "example", Name: "project"}
	collector := NewCollector(nil, repo, Options{}, nil)
	collector.SetRunCache(&Cache{base: t.TempDir()}, false, "fictional-token")
	cache := collector.runCache
	cache.now = func() time.Time { return now }
	cache.saveDays(repo, window, now.Add(-runListingFreshAge), now, []*github.WorkflowRun{runCreatedAt(1, day)}, 0, nil)
	broken := runCreatedAt(2, day)
	broken.UpdatedAt = &github.Timestamp{Time: time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC)}
	saved := make(map[int64]bool)
	cache.saveDays(repo, window, now.Add(-runListingFreshAge), now, []*github.WorkflowRun{broken}, 0, saved)
	rows, ok := cache.load(repo, day, now)
	if !ok || len(rows) != 1 || rows[0].GetID() != 1 || saved[day.Unix()] {
		t.Fatal("failed checkpoint corrupted or marked the previous valid entry saved")
	}
	broken.UpdatedAt = nil
	cache.saveDays(repo, window, now.Add(-runListingFreshAge), now, []*github.WorkflowRun{broken}, 0, saved)
	rows, ok = cache.load(repo, day, now)
	if !ok || len(rows) != 1 || rows[0].GetID() != 2 || !saved[day.Unix()] {
		t.Fatal("failed checkpoint could not be retried")
	}
}
