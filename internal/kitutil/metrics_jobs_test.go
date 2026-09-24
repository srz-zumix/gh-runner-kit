package kitutil

import (
	"strings"
	"testing"
	"time"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

func jobRows() []metrics.JobRow {
	started := time.Date(2024, 1, 1, 0, 1, 0, 0, time.UTC)
	return []metrics.JobRow{
		{JobID: 1, JobName: "build", StartedAt: &started, Wait: time.Minute},
		{JobID: 2, JobName: "pending"},
	}
}

func TestWriteMetricsJobsJSON(t *testing.T) {
	b := &strings.Builder{}
	if err := WriteMetricsJobsJSON(b, jobRows()); err != nil {
		t.Fatalf("WriteMetricsJobsJSON() error = %v", err)
	}
	got := b.String()

	for _, want := range []string{
		`"JobName": "build"`,
		`"JobID": 1`,
		`"StartedAt": "2024-01-01T00:01:00Z"`,
		`"Wait": 60000000000`,
		`"StartedAt": null`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("WriteMetricsJobsJSON() = %q, want it to contain %q", got, want)
		}
	}
	if !strings.HasPrefix(got, "[") {
		t.Fatalf("WriteMetricsJobsJSON() = %q, want a single JSON array", got)
	}
}

func TestWriteMetricsJobsNDJSON(t *testing.T) {
	b := &strings.Builder{}
	if err := WriteMetricsJobsNDJSON(b, jobRows()); err != nil {
		t.Fatalf("WriteMetricsJobsNDJSON() error = %v", err)
	}

	lines := strings.Split(strings.TrimSuffix(b.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("WriteMetricsJobsNDJSON() wrote %d lines, want 2", len(lines))
	}
	for _, line := range lines {
		if !strings.HasPrefix(line, "{") || !strings.HasSuffix(line, "}") {
			t.Fatalf("WriteMetricsJobsNDJSON() line = %q, want one JSON object per line", line)
		}
	}
}

// A GitHub job or run id can exceed 2^53, where a JSON number would be rounded
// by a consumer that parses it as a float. The ids must therefore be quoted so
// two distinct jobs never collapse onto one value.
func TestWriteMetricsJobsNDJSONQuotesLargeIDs(t *testing.T) {
	const jobID int64 = 9007199254740993 // 2^53 + 1, not representable as a float64
	b := &strings.Builder{}
	if err := WriteMetricsJobsNDJSON(b, []metrics.JobRow{{JobID: jobID, RunID: jobID, RunnerID: jobID}}); err != nil {
		t.Fatalf("WriteMetricsJobsNDJSON() error = %v", err)
	}
	got := b.String()
	for _, want := range []string{
		`"JobID":"9007199254740993"`,
		`"RunID":"9007199254740993"`,
		`"RunnerID":"9007199254740993"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("WriteMetricsJobsNDJSON() = %q, want it to contain %q", got, want)
		}
	}
}
