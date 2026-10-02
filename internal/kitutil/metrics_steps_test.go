package kitutil

import (
	"strings"
	"testing"
	"time"

	"github.com/cli/cli/v2/pkg/iostreams"
	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func TestWriteMetricsStepsNDJSONQuotesLargeIDs(t *testing.T) {
	const id int64 = 9007199254740993 // 2^53 + 1, not representable as a float64
	b := &strings.Builder{}
	rows := []metrics.StepRow{
		{RunID: id, JobID: id, StepName: "Build", StepKey: "Build", Duration: time.Second},
		{RunID: 1, JobID: 2, StepName: "Skipped"},
	}
	if err := WriteMetricsStepsNDJSON(b, rows); err != nil {
		t.Fatalf("WriteMetricsStepsNDJSON() error = %v", err)
	}
	lines := strings.Split(strings.TrimSuffix(b.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("WriteMetricsStepsNDJSON() wrote %d lines, want 2", len(lines))
	}
	for _, want := range []string{`"JobID":"9007199254740993"`, `"RunID":"9007199254740993"`, `"Duration":1000000000`, `"StepKey":"Build"`} {
		if !strings.Contains(lines[0], want) {
			t.Errorf("first line = %q, want it to contain %q", lines[0], want)
		}
	}
	if !strings.Contains(lines[1], `"StartedAt":null`) {
		t.Errorf("second line = %q, want an unset StartedAt", lines[1])
	}
}

func TestWriteMetricsStepsJSON(t *testing.T) {
	b := &strings.Builder{}
	if err := WriteMetricsStepsJSON(b, []metrics.StepRow{{RunID: 1, JobID: 2}}); err != nil {
		t.Fatalf("WriteMetricsStepsJSON() error = %v", err)
	}
	got := b.String()
	if !strings.HasPrefix(got, "[") || !strings.Contains(got, `"JobID": 2`) {
		t.Fatalf("WriteMetricsStepsJSON() = %q, want an array with numeric ids", got)
	}
}

func TestRenderMetricsStepStats(t *testing.T) {
	stats := []metrics.StepStat{
		{Repo: "octo/a", Workflow: "CI", JobName: "test", Variants: 2, StepKey: "Run", Jobs: 4, Executed: 2, Skipped: 2, Samples: 2, P50: time.Second, Share: 0.5},
		{Repo: "octo/a", Workflow: "CI", JobName: "lint", Variants: 1, StepKey: "Never", Jobs: 1, Skipped: 1},
	}

	render1 := func(stats []metrics.StepStat) string {
		streams, _, stdout, _ := iostreams.Test()
		r := render.NewRenderer(nil)
		r.IO = streams
		if err := RenderMetricsStepStats(r, stats); err != nil {
			t.Fatalf("RenderMetricsStepStats() error = %v", err)
		}
		return stdout.String()
	}

	out := render1(stats)
	for _, want := range []string{"test [x2]", "50.0%", "1s"} {
		if !strings.Contains(out, want) {
			t.Errorf("output does not contain %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "octo/a") {
		t.Errorf("a single repository should not get a REPO column:\n%s", out)
	}

	stats[1].Repo = "octo/b"
	if out := render1(stats); !strings.Contains(out, "octo/b") {
		t.Errorf("several repositories should get a REPO column:\n%s", out)
	}

	stats[1].Repo = "octo/a"
	stats[0].WorkflowPath = ".github/workflows/ci.yml"
	stats[1].WorkflowPath = ".github/workflows/release.yml"
	out = render1(stats)
	for _, want := range []string{"CI (.github/workflows/ci.yml)", "CI (.github/workflows/release.yml)"} {
		if !strings.Contains(out, want) {
			t.Errorf("workflow files sharing a name should be told apart, missing %q:\n%s", want, out)
		}
	}
}
