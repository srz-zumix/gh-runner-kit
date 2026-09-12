package kitutil

import (
	"fmt"
	"strconv"
	"time"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

// RenderMetricsSummary prints the fleet overview as a two column table.
func RenderMetricsSummary(r *render.Renderer, s metrics.Summary) error {
	if r.HasExporter() {
		return r.RenderExportedData(s)
	}

	t := r.NewTableWriter([]string{"METRIC", "VALUE"})
	rows := [][]string{
		{"RUNNERS", strconv.Itoa(s.Runners)},
		{"ONLINE", strconv.Itoa(s.Online)},
		{"BUSY", strconv.Itoa(s.Busy)},
		{"CORDONED", strconv.Itoa(s.Cordoned)},
		{"RUNS", strconv.Itoa(s.Runs)},
		{"JOBS", strconv.Itoa(s.Jobs)},
		{"HOSTED JOBS", strconv.Itoa(s.HostedJobs)},
		{"WAIT P50", FormatDurationStat(s.WaitP50, s.Jobs)},
		{"WAIT P95", FormatDurationStat(s.WaitP95, s.Jobs)},
		{"DURATION P50", FormatDurationStat(s.DurationP50, s.Jobs)},
		{"DURATION P95", FormatDurationStat(s.DurationP95, s.Jobs)},
		{"BUSY TIME", FormatDurationStat(s.BusyTime, s.Jobs)},
		{"UTILIZATION", FormatPercent(s.Utilization)},
		{"FAILURE RATE", FormatPercent(s.FailureRate)},
		{"PEAK CONCURRENCY", strconv.Itoa(s.PeakConcurrency)},
	}
	for _, row := range rows {
		t.Append(row)
	}
	if err := t.Render(); err != nil {
		return err
	}

	WriteMetricsFooter(r, s.Window, s.Runs, s.Truncated, s.Warnings)
	return nil
}

// RenderMetricsRunners prints one line per runner, label set or runner group.
func RenderMetricsRunners(r *render.Renderer, rows []metrics.RunnerRow) error {
	if r.HasExporter() {
		return r.RenderExportedData(rows)
	}

	t := r.NewTableWriter([]string{"KEY", "STATUS", "CORDONED", "JOBS", "BUSY", "UTIL", "FAIL", "WAIT P50", "DUR P50", "DUR P95", "LAST JOB"})
	for _, row := range rows {
		t.Append([]string{
			row.Key,
			row.Status,
			strconv.FormatBool(row.Cordoned),
			strconv.Itoa(row.Jobs),
			FormatDurationStat(row.BusyTime, row.Jobs),
			FormatPercent(row.Utilization),
			FormatPercent(row.FailureRate),
			FormatDurationStat(row.WaitP50, row.Jobs),
			FormatDurationStat(row.DurationP50, row.Jobs),
			FormatDurationStat(row.DurationP95, row.Jobs),
			FormatTime(row.LastJobAt),
		})
	}
	return t.Render()
}

// RenderMetricsQueue prints one line per runs-on label set.
func RenderMetricsQueue(r *render.Renderer, rows []metrics.QueueRow) error {
	if r.HasExporter() {
		return r.RenderExportedData(rows)
	}

	t := r.NewTableWriter([]string{"LABELS", "KIND", "JOBS", "WAIT P50", "WAIT P95", "WAIT MAX", "RUNNERS", "PEAK", "SATURATION"})
	for _, row := range rows {
		t.Append([]string{
			row.LabelSet(),
			string(row.Kind),
			strconv.Itoa(row.Jobs),
			FormatDurationStat(row.WaitP50, row.Jobs),
			FormatDurationStat(row.WaitP95, row.Jobs),
			FormatDurationStat(row.WaitMax, row.Jobs),
			strconv.Itoa(row.Runners),
			strconv.Itoa(row.PeakConcurrency),
			fmt.Sprintf("%.2f", row.Saturation),
		})
	}
	return t.Render()
}

// RenderMetricsLabels prints one line per single label with its demand and supply.
func RenderMetricsLabels(r *render.Renderer, rows []metrics.LabelRow) error {
	if r.HasExporter() {
		return r.RenderExportedData(rows)
	}

	t := r.NewTableWriter([]string{"LABEL", "STATUS", "JOBS", "RUNNERS", "WAIT P50", "WAIT P95", "LAST JOB"})
	for _, row := range rows {
		t.Append([]string{
			row.Label,
			string(row.Status),
			strconv.Itoa(row.Jobs),
			strconv.Itoa(row.Runners),
			FormatDurationStat(row.WaitP50, row.Jobs),
			FormatDurationStat(row.WaitP95, row.Jobs),
			FormatTime(row.LastJobAt),
		})
	}
	return t.Render()
}

// RenderMetricsConcurrency prints the concurrency timeline, one line per bucket.
func RenderMetricsConcurrency(r *render.Renderer, rows []metrics.ConcurrencyRow) error {
	if r.HasExporter() {
		return r.RenderExportedData(rows)
	}

	t := r.NewTableWriter([]string{"START", "END", "JOBS", "PEAK", "RUNNERS", "BUSY", "UTIL"})
	for _, row := range rows {
		t.Append([]string{
			FormatTime(row.Start),
			FormatTime(row.End),
			strconv.Itoa(row.Jobs),
			strconv.Itoa(row.Peak),
			strconv.Itoa(row.Runners),
			FormatDurationStat(row.BusyTime, row.Jobs),
			FormatPercent(row.Utilization),
		})
	}
	return t.Render()
}

// RenderMetricsWorkflows prints one line per workflow.
func RenderMetricsWorkflows(r *render.Renderer, rows []metrics.WorkflowRow) error {
	if r.HasExporter() {
		return r.RenderExportedData(rows)
	}

	t := r.NewTableWriter([]string{"REPOSITORY", "WORKFLOW", "PATH", "RUNS", "JOBS", "FAIL", "RETRY", "WAIT P50", "WAIT P95", "DUR P50", "DUR P95", "BUSY", "LAST JOB"})
	for _, row := range rows {
		t.Append([]string{
			FormatOptional(row.Repository),
			row.Workflow,
			FormatOptional(row.WorkflowPath),
			strconv.Itoa(row.Runs),
			strconv.Itoa(row.Jobs),
			FormatPercent(row.FailureRate),
			FormatPercent(row.RetryRate),
			FormatDurationStat(row.WaitP50, row.Jobs),
			FormatDurationStat(row.WaitP95, row.Jobs),
			FormatDurationStat(row.DurationP50, row.Jobs),
			FormatDurationStat(row.DurationP95, row.Jobs),
			FormatDurationStat(row.BusyTime, row.Jobs),
			FormatTime(row.LastJobAt),
		})
	}
	return t.Render()
}

// WriteMetricsFooter states which window the numbers cover and whether they are based
// on incomplete data, so that a truncated report is never mistaken for a full one.
func WriteMetricsFooter(r *render.Renderer, w metrics.Window, runs int, truncated bool, warnings []string) {

	r.WriteLine("")
	r.WriteLine(fmt.Sprintf("Window: %s - %s (%s), runs: %d",
		w.Start.Format(time.RFC3339), w.End.Format(time.RFC3339), FormatDuration(w.Duration()), runs))
	if truncated {
		r.WriteLine("Warning: --max-runs was reached, so the report covers only part of the window")
	}
	for _, warning := range warnings {
		logger.Warn("metrics: " + warning)
	}
}

// FormatDuration renders a duration at second precision, or a dash when it is zero.
func FormatDuration(d time.Duration) string {
	if d <= 0 {
		return "-"
	}
	return d.Round(time.Second).String()
}

// FormatDurationStat renders an aggregated duration, keeping the dash for the case
// where nothing was measured so that it is not confused with a measured zero.
func FormatDurationStat(d time.Duration, samples int) string {
	if samples == 0 {
		return "-"
	}
	return max(d, 0).Round(time.Second).String()
}

// FormatPercent renders a ratio in the 0..1 range as a percentage.
func FormatPercent(v float64) string {
	return fmt.Sprintf("%.1f%%", v*100)
}

// FormatTime renders a timestamp, or a dash when it is unset.
func FormatTime(t time.Time) string {
	if t.IsZero() {
		return "-"
	}
	return t.Format(time.RFC3339)
}

// FormatOptional renders a string, or a dash when it is empty, so a missing value is not
// shown as a blank cell.
func FormatOptional(s string) string {
	if s == "" {
		return "-"
	}
	return s
}
