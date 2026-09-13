package kitutil

import (
	"strings"
	"testing"
	"time"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

func exportReport() metrics.ExportReport {
	start := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	window := metrics.Window{Start: start, End: start.Add(time.Hour)}

	return metrics.ExportReport{
		Window: window,
		Repos:  []string{"owner/repo"},
		Summary: metrics.Summary{
			Window:      window,
			Runners:     2,
			Online:      2,
			Jobs:        4,
			WaitP95:     90 * time.Second,
			Utilization: 0.25,
		},
		Pools: []metrics.QueueRow{
			{Labels: []string{"self-hosted", `weird"label`}, Jobs: 4, Runners: 2, WaitP95: 90 * time.Second},
		},
		Labels: []metrics.LabelRow{
			{Label: "self-hosted", Status: metrics.LabelStatusOK, Jobs: 4, Runners: 2},
		},
	}
}

func TestWriteMetricsPrometheus(t *testing.T) {
	b := &strings.Builder{}
	if err := WriteMetricsPrometheus(b, exportReport()); err != nil {
		t.Fatalf("WriteMetricsPrometheus() error = %v", err)
	}
	got := b.String()

	for _, want := range []string{
		"# TYPE gh_runner_kit_runners gauge\ngh_runner_kit_runners 2\n",
		"gh_runner_kit_wait_p95_seconds 90\n",
		"gh_runner_kit_utilization 0.25\n",
		"gh_runner_kit_window_seconds 3600\n",
		`gh_runner_kit_label_jobs{label="self-hosted",status="ok"} 4`,
	} {
		if !strings.Contains(got, want) {
			t.Errorf("WriteMetricsPrometheus() output does not contain %q:\n%s", want, got)
		}
	}
}

func TestWriteMetricsPrometheusEscapesLabelValues(t *testing.T) {
	b := &strings.Builder{}
	if err := WriteMetricsPrometheus(b, exportReport()); err != nil {
		t.Fatalf("WriteMetricsPrometheus() error = %v", err)
	}

	want := `gh_runner_kit_pool_jobs{labels="self-hosted,weird\"label"} 4`
	if !strings.Contains(b.String(), want) {
		t.Errorf("WriteMetricsPrometheus() output does not contain %q:\n%s", want, b.String())
	}
}

func TestWriteMetricsPrometheusDeclaresEachMetricOnce(t *testing.T) {
	b := &strings.Builder{}
	report := exportReport()
	report.Pools = append(report.Pools, metrics.QueueRow{Labels: []string{"linux"}, Jobs: 1, Runners: 1})

	if err := WriteMetricsPrometheus(b, report); err != nil {
		t.Fatalf("WriteMetricsPrometheus() error = %v", err)
	}
	if got := strings.Count(b.String(), "# TYPE gh_runner_kit_pool_jobs gauge"); got != 1 {
		t.Errorf("TYPE line count = %d, want 1", got)
	}
}

func TestWriteMetricsMarkdown(t *testing.T) {
	b := &strings.Builder{}
	if err := WriteMetricsMarkdown(b, exportReport()); err != nil {
		t.Fatalf("WriteMetricsMarkdown() error = %v", err)
	}
	got := b.String()

	for _, want := range []string{
		"## Self-hosted runner metrics",
		"| Metric | Value |",
		"| Runners | 2 |",
		"### Queue time per runs-on label set",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("WriteMetricsMarkdown() output does not contain %q:\n%s", want, got)
		}
	}
}

func TestWriteMetricsMarkdownEscapesCells(t *testing.T) {
	b := &strings.Builder{}
	report := exportReport()
	report.Pools[0].Labels = []string{"a|b"}

	if err := WriteMetricsMarkdown(b, report); err != nil {
		t.Fatalf("WriteMetricsMarkdown() error = %v", err)
	}
	if !strings.Contains(b.String(), `| a\|b |`) {
		t.Errorf("WriteMetricsMarkdown() did not escape the cell separator:\n%s", b.String())
	}
}
