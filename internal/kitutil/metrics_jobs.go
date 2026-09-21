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

// WriteMetricsJobsNDJSON writes one JSON object per line, which a downstream tool can
// consume row by row instead of having to parse the whole listing first.
func WriteMetricsJobsNDJSON(w io.Writer, rows []metrics.JobRow) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	for _, row := range rows {
		if err := enc.Encode(row); err != nil {
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

// WriteMetricsRunsNDJSON writes one run object per line.
func WriteMetricsRunsNDJSON(w io.Writer, rows []metrics.RunRow) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	for _, row := range rows {
		if err := enc.Encode(row); err != nil {
			return err
		}
	}
	return nil
}
