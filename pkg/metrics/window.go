package metrics

import (
	"fmt"
	"time"
)

// Window is the closed-open time range [Start, End) that a metrics run aggregates over.
type Window struct {
	Start time.Time
	End   time.Time
}

// sinceLayouts are the accepted --since formats, tried in order.
var sinceLayouts = []string{
	time.RFC3339,
	"2006-01-02T15:04:05",
	"2006-01-02 15:04:05",
	"2006-01-02",
}

// ParseWindow builds the aggregation window from the --days and --since flag values.
// since takes precedence when set; the caller is responsible for rejecting the
// combination of both.
func ParseWindow(days int, since string, now time.Time) (Window, error) {
	end := now.UTC()

	if since != "" {
		start, err := parseSince(since)
		if err != nil {
			return Window{}, err
		}
		if !start.Before(end) {
			return Window{}, fmt.Errorf("since %q is not in the past", since)
		}
		return Window{Start: start, End: end}, nil
	}

	if days <= 0 {
		return Window{}, fmt.Errorf("days must be greater than 0, got %d", days)
	}
	return Window{Start: end.AddDate(0, 0, -days), End: end}, nil
}

func parseSince(since string) (time.Time, error) {
	for _, layout := range sinceLayouts {
		if t, err := time.Parse(layout, since); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("failed to parse since %q: expected YYYY-MM-DD or RFC3339", since)
}

// Duration returns the length of the window.
func (w Window) Duration() time.Duration {
	return w.End.Sub(w.Start)
}

// Created returns the value for the GitHub Actions API "created" filter.
func (w Window) Created() string {
	return ">=" + w.Start.Format("2006-01-02")
}

// Contains reports whether t falls inside the window.
func (w Window) Contains(t time.Time) bool {
	return !t.Before(w.Start) && t.Before(w.End)
}

// Clamp trims an interval to the window, reporting false when they do not overlap.
func (w Window) Clamp(iv Interval) (Interval, bool) {
	if iv.Start.Before(w.Start) {
		iv.Start = w.Start
	}
	if iv.End.After(w.End) {
		iv.End = w.End
	}
	if !iv.End.After(iv.Start) {
		return Interval{}, false
	}
	return iv, true
}
