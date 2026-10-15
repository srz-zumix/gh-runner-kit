package kitutil

import (
	"encoding/json"
	"io"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

// MetricsProgressWriter emits versioned NDJSON independently of snapshot stdout.
func MetricsProgressWriter(writer io.Writer) func(metrics.CollectionProgress) error {
	encoder := json.NewEncoder(writer)
	return func(progress metrics.CollectionProgress) error {
		return encoder.Encode(struct {
			Type    string `json:"type"`
			Version int    `json:"version"`
			metrics.CollectionProgress
		}{Type: "runner-kit.metrics.progress", Version: 1, CollectionProgress: progress})
	}
}
