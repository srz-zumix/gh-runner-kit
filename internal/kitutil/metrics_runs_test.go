package kitutil

import (
	"strings"
	"testing"
	"time"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

func runRows() []metrics.RunRow {
	created := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	started := time.Date(2024, 1, 1, 0, 1, 0, 0, time.UTC)
	return []metrics.RunRow{
		{
			Repository: "owner/repo",
			Workflow:   "CI",
			RunID:      1,
			CreatedAt:  &created,
			StartedAt:  &started,
		},
		{
			Repository: "owner/repo",
			Workflow:   "Release",
			RunID:      2,
		},
	}
}

func TestWriteMetricsRunsJSON(t *testing.T) {
	b := &strings.Builder{}
	if err := WriteMetricsRunsJSON(b, runRows()); err != nil {
		t.Fatalf("WriteMetricsRunsJSON() error = %v", err)
	}
	got := b.String()

	for _, want := range []string{
		`"Workflow": "CI"`,
		`"RunID": 1`,
		`"CreatedAt": "2024-01-01T00:00:00Z"`,
		`"StartedAt": "2024-01-01T00:01:00Z"`,
		`"CreatedAt": null`,
		`"StartedAt": null`,
		`"UpdatedAt": null`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("WriteMetricsRunsJSON() = %q, want it to contain %q", got, want)
		}
	}
	if !strings.HasPrefix(got, "[") {
		t.Fatalf("WriteMetricsRunsJSON() = %q, want a single JSON array", got)
	}
}

func TestWriteMetricsRunsNDJSON(t *testing.T) {
	b := &strings.Builder{}
	if err := WriteMetricsRunsNDJSON(b, runRows()); err != nil {
		t.Fatalf("WriteMetricsRunsNDJSON() error = %v", err)
	}

	lines := strings.Split(strings.TrimSuffix(b.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("WriteMetricsRunsNDJSON() wrote %d lines, want 2", len(lines))
	}
	for _, line := range lines {
		if !strings.HasPrefix(line, "{") || !strings.HasSuffix(line, "}") {
			t.Fatalf("WriteMetricsRunsNDJSON() line = %q, want one JSON object per line", line)
		}
	}
	if !strings.Contains(lines[1], `"StartedAt":null`) {
		t.Fatalf("WriteMetricsRunsNDJSON() second line = %q, want an unset StartedAt", lines[1])
	}
}

// A GitHub workflow or run id can exceed 2^53, where a JSON number would be rounded by a
// consumer that parses it as a float. The NDJSON stream therefore quotes them, while the
// indented JSON above keeps them numeric for the existing `--format json` contract.
func TestWriteMetricsRunsNDJSONQuotesLargeIDs(t *testing.T) {
	const id int64 = 9007199254740993 // 2^53 + 1, not representable as a float64
	b := &strings.Builder{}
	if err := WriteMetricsRunsNDJSON(b, []metrics.RunRow{{WorkflowID: id, RunID: id}}); err != nil {
		t.Fatalf("WriteMetricsRunsNDJSON() error = %v", err)
	}
	got := b.String()
	for _, want := range []string{
		`"WorkflowID":"9007199254740993"`,
		`"RunID":"9007199254740993"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("WriteMetricsRunsNDJSON() = %q, want it to contain %q", got, want)
		}
	}
}
