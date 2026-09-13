package kitutil

import (
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

// metricPrefix namespaces every exported series.
const metricPrefix = "gh_runner_kit_"

// promMetric is one gauge of the Prometheus exposition.
type promMetric struct {
	name   string
	help   string
	labels map[string]string
	value  float64
}

// WriteMetricsPrometheus writes the report as a Prometheus text exposition. Durations are
// expressed in seconds and ratios in the 0..1 range, as the exposition format expects.
func WriteMetricsPrometheus(w io.Writer, report metrics.ExportReport) error {
	s := report.Summary

	series := []promMetric{
		{name: "window_seconds", help: "Length of the aggregation window.", value: report.Window.Duration().Seconds()},
		{name: "repositories", help: "Number of repositories the runs were collected from.", value: float64(len(report.Repos))},
		{name: "runners", help: "Number of registered self-hosted runners.", value: float64(s.Runners)},
		{name: "runners_online", help: "Number of self-hosted runners that are online.", value: float64(s.Online)},
		{name: "runners_busy", help: "Number of self-hosted runners that are running a job.", value: float64(s.Busy)},
		{name: "runners_cordoned", help: "Number of self-hosted runners that are cordoned.", value: float64(s.Cordoned)},
		{name: "runs", help: "Number of workflow runs in the window.", value: float64(s.Runs)},
		{name: "jobs", help: "Number of self-hosted jobs in the window.", value: float64(s.Jobs)},
		{name: "hosted_jobs", help: "Number of GitHub-hosted jobs in the window.", value: float64(s.HostedJobs)},
		{name: "wait_p50_seconds", help: "Median time a self-hosted job waited for a runner.", value: s.WaitP50.Seconds()},
		{name: "wait_p95_seconds", help: "95th percentile of the time a self-hosted job waited for a runner.", value: s.WaitP95.Seconds()},
		{name: "duration_p50_seconds", help: "Median time a self-hosted job occupied a runner.", value: s.DurationP50.Seconds()},
		{name: "duration_p95_seconds", help: "95th percentile of the time a self-hosted job occupied a runner.", value: s.DurationP95.Seconds()},
		{name: "busy_seconds", help: "Total time the self-hosted jobs occupied a runner.", value: s.BusyTime.Seconds()},
		{name: "utilization", help: "Share of the fleet capacity the self-hosted jobs consumed.", value: s.Utilization},
		{name: "failure_rate", help: "Share of the decided self-hosted jobs that failed.", value: s.FailureRate},
		{name: "peak_concurrency", help: "Highest number of self-hosted jobs that ran at the same time.", value: float64(s.PeakConcurrency)},
		{name: "truncated", help: "1 when the collection stopped at the run limit.", value: boolValue(s.Truncated)},
	}

	for _, pool := range report.Pools {
		labels := map[string]string{"labels": pool.LabelSet()}
		series = append(series,
			promMetric{name: "pool_jobs", help: "Number of jobs that requested this runs-on label set.", labels: labels, value: float64(pool.Jobs)},
			promMetric{name: "pool_runners", help: "Number of runners that can serve this runs-on label set.", labels: labels, value: float64(pool.Runners)},
			promMetric{name: "pool_wait_p95_seconds", help: "95th percentile of the time this runs-on label set waited.", labels: labels, value: pool.WaitP95.Seconds()},
			promMetric{name: "pool_peak_concurrency", help: "Highest number of jobs of this runs-on label set that ran at the same time.", labels: labels, value: float64(pool.PeakConcurrency)},
		)
	}

	for _, label := range report.Labels {
		labels := map[string]string{"label": label.Label, "status": string(label.Status)}
		series = append(series,
			promMetric{name: "label_jobs", help: "Number of jobs that requested this label.", labels: labels, value: float64(label.Jobs)},
			promMetric{name: "label_runners", help: "Number of runners that carry this label.", labels: labels, value: float64(label.Runners)},
		)
	}

	return writePrometheusSeries(w, series)
}

// writePrometheusSeries emits the series, grouping the HELP and TYPE lines of a metric
// before its first sample as the exposition format requires.
func writePrometheusSeries(w io.Writer, series []promMetric) error {
	declared := map[string]bool{}

	for _, m := range series {
		name := metricPrefix + m.name
		if !declared[name] {
			declared[name] = true
			if _, err := fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n", name, m.help, name); err != nil {
				return err
			}
		}
		if _, err := fmt.Fprintf(w, "%s%s %s\n", name, formatPrometheusLabels(m.labels), formatPrometheusValue(m.value)); err != nil {
			return err
		}
	}
	return nil
}

// formatPrometheusValue renders a sample in plain decimal notation, which stays readable
// for the large second counts a long window produces.
func formatPrometheusValue(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// formatPrometheusLabels renders the label set, keeping the label names in a fixed order
// so that repeated exports of the same fleet produce identical output.
func formatPrometheusLabels(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}

	// Only the two label names below are ever used, and they are emitted in this order.
	var parts []string
	for _, name := range []string{"label", "labels", "status"} {
		if value, ok := labels[name]; ok {
			parts = append(parts, name+`="`+escapePrometheusLabel(value)+`"`)
		}
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// escapePrometheusLabel escapes the characters the exposition format reserves inside a
// label value. Label values come from user-defined runner labels, so they are untrusted.
func escapePrometheusLabel(value string) string {
	return strings.NewReplacer(`\`, `\\`, "\n", `\n`, `"`, `\"`).Replace(value)
}

func boolValue(v bool) float64 {
	if v {
		return 1
	}
	return 0
}

// WriteMetricsMarkdown writes the report as Markdown, which is what a workflow appends to
// the file named by GITHUB_STEP_SUMMARY.
func WriteMetricsMarkdown(w io.Writer, report metrics.ExportReport) error {
	s := report.Summary

	b := &strings.Builder{}
	b.WriteString("## Self-hosted runner metrics\n\n")
	fmt.Fprintf(b, "Window: %s to %s\n\n", FormatTime(report.Window.Start), FormatTime(report.Window.End))

	b.WriteString("| Metric | Value |\n| --- | --- |\n")
	for _, row := range [][2]string{
		{"Runners", fmt.Sprintf("%d", s.Runners)},
		{"Online", fmt.Sprintf("%d", s.Online)},
		{"Busy", fmt.Sprintf("%d", s.Busy)},
		{"Cordoned", fmt.Sprintf("%d", s.Cordoned)},
		{"Runs", fmt.Sprintf("%d", s.Runs)},
		{"Jobs", fmt.Sprintf("%d", s.Jobs)},
		{"Hosted jobs", fmt.Sprintf("%d", s.HostedJobs)},
		{"Wait p50", FormatDurationStat(s.WaitP50, s.Jobs)},
		{"Wait p95", FormatDurationStat(s.WaitP95, s.Jobs)},
		{"Duration p50", FormatDurationStat(s.DurationP50, s.Jobs)},
		{"Duration p95", FormatDurationStat(s.DurationP95, s.Jobs)},
		{"Utilization", FormatPercent(s.Utilization)},
		{"Failure rate", FormatPercent(s.FailureRate)},
		{"Peak concurrency", fmt.Sprintf("%d", s.PeakConcurrency)},
	} {
		fmt.Fprintf(b, "| %s | %s |\n", row[0], escapeMarkdownCell(row[1]))
	}

	if len(report.Pools) > 0 {
		b.WriteString("\n### Queue time per runs-on label set\n\n")
		b.WriteString("| Labels | Jobs | Runners | Wait p50 | Wait p95 | Peak |\n| --- | --- | --- | --- | --- | --- |\n")
		for _, pool := range report.Pools {
			fmt.Fprintf(b, "| %s | %d | %d | %s | %s | %d |\n",
				escapeMarkdownCell(pool.LabelSet()),
				pool.Jobs,
				pool.Runners,
				FormatDurationStat(pool.WaitP50, pool.Jobs),
				FormatDurationStat(pool.WaitP95, pool.Jobs),
				pool.PeakConcurrency,
			)
		}
	}

	if s.Truncated {
		b.WriteString("\nThe collection stopped at the run limit, so the numbers cover only part of the window.\n")
	}

	_, err := io.WriteString(w, b.String())
	return err
}

// escapeMarkdownCell keeps user-defined label names from breaking out of a table cell.
func escapeMarkdownCell(value string) string {
	return strings.NewReplacer("|", `\|`, "\n", " ").Replace(value)
}
