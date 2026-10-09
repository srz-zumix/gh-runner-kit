package metrics

import (
	"context"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/go-github/v90/github"
)

func TestCollectWindowRunsSearchCap(t *testing.T) {
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	window := Window{Start: start, End: start.Add(time.Hour)}
	all := make([]*github.WorkflowRun, 2600)
	for i := range all {
		all[i] = runCreatedAt(int64(i+1), start.Add(time.Duration(i)*time.Second))
	}
	slices.Reverse(all)
	for _, budget := range []int{0, 75, 1200, 5000} {
		t.Run(strconv.Itoa(budget), func(t *testing.T) {
			calls := 0
			got, err := collectWindowRuns(context.Background(), window, budget, func(created string, cap int) ([]*github.WorkflowRun, error) {
				calls++
				parts := strings.Split(created, "..")
				from, err := time.Parse(time.RFC3339, parts[0])
				if err != nil {
					t.Fatal(err)
				}
				to, err := time.Parse(time.RFC3339, parts[1])
				if err != nil {
					t.Fatal(err)
				}
				var rows []*github.WorkflowRun
				for _, run := range all {
					at := run.GetCreatedAt().Time
					if !at.Before(from) && !at.After(to) {
						rows = append(rows, run)
					}
				}
				if len(rows) > cap {
					rows = rows[:cap]
				}
				return rows, nil
			})
			if err != nil {
				t.Fatal(err)
			}
			want := len(all)
			if budget > 0 && budget < want {
				want = budget
			}
			if len(got) != want {
				t.Fatalf("got %d runs, want %d", len(got), want)
			}
			for i, run := range got {
				if run.GetID() != all[i].GetID() {
					t.Fatalf("run %d: got %d, want %d", i, run.GetID(), all[i].GetID())
				}
			}
			if budget == 75 && calls != 1 {
				t.Fatalf("bounded search used %d calls, want 1", calls)
			}
		})
	}
}

func TestCollectWindowRunsSaturatedSecond(t *testing.T) {
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	rows := make([]*github.WorkflowRun, workflowRunSearchCap)
	for i := range rows {
		rows[i] = runCreatedAt(int64(i+1), start)
	}
	_, err := collectWindowRuns(context.Background(), Window{Start: start, End: start.Add(time.Second)}, 0, func(string, int) ([]*github.WorkflowRun, error) {
		return rows, nil
	})
	if err == nil || !strings.Contains(err.Error(), "complete coverage cannot be guaranteed") {
		t.Fatalf("got %v, want explicit incomplete coverage error", err)
	}
}

func TestCollectWindowRunsExactBoundariesAndErrors(t *testing.T) {
	start := time.Date(2026, 10, 1, 0, 0, 0, 500000000, time.UTC)
	window := Window{Start: start, End: start.Truncate(time.Second).Add(3 * time.Second)}
	_, err := collectWindowRuns(context.Background(), window, 1, func(created string, limit int) ([]*github.WorkflowRun, error) {
		if created != "2026-10-01T00:00:01Z..2026-10-01T00:00:02Z" || limit != 1 {
			t.Fatalf("incorrect closed-open boundary or budget: %s, %d", created, limit)
		}
		return nil, context.Canceled
	})
	if err != context.Canceled {
		t.Fatalf("request error was swallowed: %v", err)
	}
}

func TestMergeCollectedJobs(t *testing.T) {
	first := jobWithID(1)
	second := jobWithID(2)
	merged := mergeCollectedJobs([]*github.WorkflowJob{second, first}, []*github.WorkflowJob{first, jobWithID(3)})
	if len(merged) != 3 || merged[0] != second || merged[1] != first {
		t.Fatalf("unexpected carried-over job merge: %#v", merged)
	}
}
