package kitutil

import (
	"encoding/json"
	"io"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

// WriteMetricsJobsJSON writes the job listing as a single indented JSON array.
func WriteMetricsJobsJSON(w io.Writer, rows []metrics.JobRow) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(rows)
}

// jobRowNDJSON is the NDJSON wire shape of a JobRow. A GitHub run, job or runner id can
// exceed 2^53, where a JSON consumer that parses a number as a float64 would round two
// distinct ids onto one value; the ids are therefore quoted for the row-by-row stream
// the extension consumes. The shared JobRow keeps numeric ids so the `--format json`
// contract other tools filter with a numeric comparison stays unchanged.
type jobRowNDJSON struct {
	metrics.JobRow
	RunID    int64 `json:"RunID,string"`
	JobID    int64 `json:"JobID,string"`
	RunnerID int64 `json:"RunnerID,string"`
}

func toJobRowNDJSON(row metrics.JobRow) jobRowNDJSON {
	return jobRowNDJSON{JobRow: row, RunID: row.RunID, JobID: row.JobID, RunnerID: row.RunnerID}
}

// WriteMetricsJobsNDJSON writes one JSON object per line, which a downstream tool can
// consume row by row instead of having to parse the whole listing first.
func WriteMetricsJobsNDJSON(w io.Writer, rows []metrics.JobRow) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	for _, row := range rows {
		if err := enc.Encode(toJobRowNDJSON(row)); err != nil {
			return err
		}
	}
	return nil
}

// WriteMetricsRunsJSON writes the run listing as a single indented JSON array.
func WriteMetricsRunsJSON(w io.Writer, rows []metrics.RunRow) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(rows)
}

// runRowNDJSON is the NDJSON wire shape of a RunRow. Its ids are quoted for the same
// reason as jobRowNDJSON: a workflow or run id past 2^53 would otherwise be rounded by a
// consumer that reads it as a float64. The shared RunRow keeps numeric ids so the
// `--format json` contract stays unchanged.
type runRowNDJSON struct {
	metrics.RunRow
	WorkflowID int64 `json:"WorkflowID,string"`
	RunID      int64 `json:"RunID,string"`
}

func toRunRowNDJSON(row metrics.RunRow) runRowNDJSON {
	return runRowNDJSON{RunRow: row, WorkflowID: row.WorkflowID, RunID: row.RunID}
}

// WriteMetricsRunsNDJSON writes one run object per line.
func WriteMetricsRunsNDJSON(w io.Writer, rows []metrics.RunRow) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	for _, row := range rows {
		if err := enc.Encode(toRunRowNDJSON(row)); err != nil {
			return err
		}
	}
	return nil
}
