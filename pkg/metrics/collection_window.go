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

// collectWindowRuns splits saturated searches rather than mistaking the API cap
// for the end of the selected window. Newer halves consume positive budgets first.
func collectWindowRuns(ctx context.Context, window Window, limit int, list func(string, int) ([]*github.WorkflowRun, error)) ([]*github.WorkflowRun, error) {
	var walk func(time.Time, time.Time, int) ([]*github.WorkflowRun, error)
	walk = func(start, end time.Time, budget int) ([]*github.WorkflowRun, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		cap := workflowRunSearchCap
		if budget > 0 && budget < cap {
			cap = budget
		}
		rows, err := list(start.UTC().Format(time.RFC3339)+".."+end.UTC().Format(time.RFC3339), cap)
		if err != nil {
			return nil, err
		}
		if len(rows) < workflowRunSearchCap || (budget > 0 && budget <= workflowRunSearchCap) {
			return rows, nil
		}
		if !start.Before(end) {
			return nil, fmt.Errorf("workflow run search reached the %d-result API cap within one second at %s; complete coverage cannot be guaranteed", workflowRunSearchCap, start.Format(time.RFC3339))
		}
		mid := time.Unix(start.Unix()+(end.Unix()-start.Unix())/2+1, 0).UTC()
		newer, err := walk(mid, end, budget)
		if err != nil || (budget > 0 && len(newer) >= budget) {
			return newer, err
		}
		remaining := budget
		if budget > 0 {
			remaining -= len(newer)
		}
		older, err := walk(start, mid.Add(-time.Second), remaining)
		if err != nil {
			return nil, err
		}
		seen := make(map[int64]bool, len(newer)+len(older))
		combined := make([]*github.WorkflowRun, 0, len(newer)+len(older))
		for _, run := range append(newer, older...) {
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
		return combined, nil
	}
	start := window.Start.Truncate(time.Second)
	if start.Before(window.Start) {
		start = start.Add(time.Second)
	}
	end := window.End.Add(-time.Nanosecond).Truncate(time.Second)
	if end.Before(start) {
		return nil, nil
	}
	return walk(start, end, limit)
}
