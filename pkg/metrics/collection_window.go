package metrics

import (
	"cmp"
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/google/go-github/v90/github"
)

const workflowRunSearchCap = 1000

type runWindowCheckpoint struct {
	now      func() time.Time
	complete func(Window, []*github.WorkflowRun, time.Time)
}

type runWindowResult struct {
	rows     []*github.WorkflowRun
	complete bool
	started  time.Time
}

// collectWindowRuns splits saturated searches rather than mistaking the API cap
// for the end of the selected window. Newer halves consume positive budgets first.
func collectWindowRuns(ctx context.Context, window Window, limit int, list func(string, int) ([]*github.WorkflowRun, error), checkpoint *runWindowCheckpoint) ([]*github.WorkflowRun, error) {
	now := time.Now
	if checkpoint != nil {
		now = checkpoint.now
	}
	finish := func(start, end time.Time, result runWindowResult) runWindowResult {
		if checkpoint != nil && result.complete {
			covered := Window{Start: start, End: end.Add(time.Second)}
			if covered.Start.Before(window.Start) {
				covered.Start = window.Start
			}
			if covered.End.After(window.End) {
				covered.End = window.End
			}
			checkpoint.complete(covered, result.rows, result.started)
		}
		return result
	}
	var walk func(time.Time, time.Time, int) (runWindowResult, error)
	walk = func(start, end time.Time, budget int) (runWindowResult, error) {
		if err := ctx.Err(); err != nil {
			return runWindowResult{}, err
		}
		cap := workflowRunSearchCap
		if budget > 0 && budget < cap {
			cap = budget
		}
		started := now().UTC()
		rows, err := list(start.UTC().Format(time.RFC3339)+".."+end.UTC().Format(time.RFC3339), cap)
		if err != nil {
			return runWindowResult{}, err
		}
		if len(rows) < workflowRunSearchCap || (budget > 0 && budget <= workflowRunSearchCap) {
			return finish(start, end, runWindowResult{rows: rows, complete: len(rows) < cap, started: started}), nil
		}
		if !start.Before(end) {
			return runWindowResult{}, fmt.Errorf("workflow run search reached the %d-result API cap within one second at %s; complete coverage cannot be guaranteed", workflowRunSearchCap, start.Format(time.RFC3339))
		}
		mid := time.Unix(start.Unix()+(end.Unix()-start.Unix())/2+1, 0).UTC()
		if checkpoint != nil {
			// Midnight splits let complete days be saved before older searches finish.
			day := mid.Truncate(24 * time.Hour)
			if !day.After(start) {
				day = day.Add(24 * time.Hour)
			}
			if day.After(start) && !day.After(end) {
				mid = day
			}
		}
		newer, err := walk(mid, end, budget)
		if err != nil {
			return newer, err
		}
		if budget > 0 && len(newer.rows) >= budget {
			newer.complete = false
			return newer, nil
		}
		remaining := budget
		if budget > 0 {
			remaining -= len(newer.rows)
		}
		older, err := walk(start, mid.Add(-time.Second), remaining)
		if err != nil {
			return runWindowResult{}, err
		}
		seen := make(map[int64]bool, len(newer.rows)+len(older.rows))
		combined := make([]*github.WorkflowRun, 0, len(newer.rows)+len(older.rows))
		for _, run := range append(newer.rows, older.rows...) {
			if !seen[run.GetID()] {
				seen[run.GetID()] = true
				combined = append(combined, run)
			}
		}
		slices.SortFunc(combined, func(a, b *github.WorkflowRun) int {
			if order := b.GetCreatedAt().Compare(a.GetCreatedAt().Time); order != 0 {
				return order
			}
			return cmp.Compare(b.GetID(), a.GetID())
		})
		if budget > 0 && len(combined) > budget {
			combined = combined[:budget]
		}
		started = newer.started
		if older.started.Before(started) {
			started = older.started
		}
		return finish(start, end, runWindowResult{rows: combined, complete: newer.complete && older.complete, started: started}), nil
	}
	start := window.Start.Truncate(time.Second)
	if start.Before(window.Start) {
		start = start.Add(time.Second)
	}
	end := window.End.Add(-time.Nanosecond).Truncate(time.Second)
	if end.Before(start) {
		return nil, nil
	}
	result, err := walk(start, end, limit)
	return result.rows, err
}
