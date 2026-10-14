package kitutil

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"testing"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

type failedProgressWriter struct{}

func (failedProgressWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestMetricsProgressWriter(t *testing.T) {
	var output bytes.Buffer
	write := MetricsProgressWriter(&output)
	progress := metrics.CollectionProgress{Stage: "jobs", Unit: "runs", Repository: "example/project", RepositoryIndex: 1, RepositoriesTotal: 1, Completed: 3, Total: 5, Cached: 1, Fetched: 2}
	if err := write(progress); err != nil {
		t.Fatal(err)
	}
	var record struct {
		Type    string `json:"type"`
		Version int    `json:"version"`
		metrics.CollectionProgress
	}
	if err := json.Unmarshal(output.Bytes(), &record); err != nil {
		t.Fatal(err)
	}
	if record.Type != "runner-kit.metrics.progress" || record.Version != 1 || record.CollectionProgress != progress {
		t.Fatalf("invalid progress record %+v", record)
	}
	if !bytes.HasSuffix(output.Bytes(), []byte("\n")) {
		t.Fatal("progress record is not newline-delimited")
	}
	if err := MetricsProgressWriter(failedProgressWriter{})(progress); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write error was lost: %v", err)
	}
}
