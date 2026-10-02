package kitutil

import (
	"encoding/json"
	"io"
	"strconv"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

// WriteMetricsStepsJSON writes the step listing as a single indented JSON array.
func WriteMetricsStepsJSON(w io.Writer, rows []metrics.StepRow) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(rows)
}

// stepRowNDJSON is the NDJSON wire shape of a StepRow. Its ids are quoted for the same
// reason as jobRowNDJSON: a run or job id past 2^53 would otherwise be rounded by a
// consumer that reads it as a float64.
type stepRowNDJSON struct {
	metrics.StepRow
	RunID int64 `json:"RunID,string"`
	JobID int64 `json:"JobID,string"`
}

// WriteMetricsStepsNDJSON writes one step object per line.
func WriteMetricsStepsNDJSON(w io.Writer, rows []metrics.StepRow) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	for _, row := range rows {
		if err := enc.Encode(stepRowNDJSON{StepRow: row, RunID: row.RunID, JobID: row.JobID}); err != nil {
			return err
		}
	}
	return nil
}

// RenderMetricsStepStats prints one line per step of every job. The REPO column is only
// shown when the statistics span more than one repository.
func RenderMetricsStepStats(r *render.Renderer, stats []metrics.StepStat) error {
	withRepo := false
	for _, s := range stats {
		if s.Repo != stats[0].Repo {
			withRepo = true
			break
		}
	}

	header := []string{"WORKFLOW", "JOB", "STEP", "RUNS", "PRESENCE", "SKIPPED", "FAILURE", "DUR P50", "DUR P90", "DUR MAX", "SHARE", "OFFSET"}
	if withRepo {
		header = append([]string{"REPO"}, header...)
	}
	t := r.NewTableWriter(header)
	for _, s := range stats {
		job := s.JobName
		if s.Variants > 1 {
			job += " [x" + strconv.Itoa(s.Variants) + "]"
		}
		failure := "-"
		if s.Executed > 0 {
			failure = FormatPercent(s.FailureRate())
		}
		share := "-"
		if s.Samples > 0 {
			share = FormatPercent(s.Share)
		}
		row := []string{
			FormatOptional(s.Workflow),
			job,
			FormatOptional(s.StepKey),
			strconv.Itoa(s.Executed),
			FormatPercent(s.Presence()),
			strconv.Itoa(s.Skipped),
			failure,
			FormatDurationStat(s.P50, s.Samples),
			FormatDurationStat(s.P90, s.Samples),
			FormatDurationStat(s.Max, s.Samples),
			share,
			FormatDurationStat(s.Offset, s.Samples),
		}
		if withRepo {
			row = append([]string{FormatOptional(s.Repo)}, row...)
		}
		t.Append(row)
	}
	return t.Render()
}
