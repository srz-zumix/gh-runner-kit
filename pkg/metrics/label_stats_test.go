package metrics

import (
	"testing"
)

func TestBuildLabelStats(t *testing.T) {
	data := testData()
	// A label no registered runner carries, so the job could never have been served by
	// the current inventory.
	data.Jobs = append(data.Jobs, testJob("train", 0, "", []string{"self-hosted", "gpu"}, "success", 0, 5, 25))

	rows := BuildLabelStats(data)

	want := []struct {
		label   string
		status  LabelStatus
		jobs    int
		runners int
	}{
		{"gpu", LabelStatusOrphan, 1, 0},
		{"cordoned", LabelStatusUnused, 0, 1},
		{"self-hosted", LabelStatusOK, 4, 3},
		{"linux", LabelStatusOK, 3, 3},
	}

	if len(rows) != len(want) {
		t.Fatalf("len(BuildLabelStats()) = %d, want %d: %+v", len(rows), len(want), rows)
	}
	for i, w := range want {
		row := rows[i]
		if row.Label != w.label || row.Status != w.status || row.Jobs != w.jobs || row.Runners != w.runners {
			t.Fatalf("row %d = %+v, want label %q status %q jobs %d runners %d",
				i, row, w.label, w.status, w.jobs, w.runners)
		}
	}
}

func TestBuildLabelStatsExcludesHostedJobs(t *testing.T) {
	for _, row := range BuildLabelStats(testData()) {
		if row.Label == "ubuntu-latest" {
			t.Fatalf("BuildLabelStats() reported a hosted label: %+v", row)
		}
	}
}
