package metrics

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

func testSnapshot() *Snapshot {
	return &Snapshot{
		Version:   CurrentSnapshotVersion,
		CreatedAt: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC),
		Repo:      repository.Repository{Host: "github.com", Owner: "octo", Name: "alpha"},
		Contents:  SnapshotContents{Jobs: true, Usage: true, Runners: true},
		Data: &Data{
			Window:  Window{Start: time.Date(2026, 8, 25, 0, 0, 0, 0, time.UTC), End: time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)},
			Runners: []*github.Runner{{ID: github.Ptr(int64(1)), Name: github.Ptr("runner-1")}},
			Runs:    []*github.WorkflowRun{{ID: github.Ptr(int64(100))}},
			Jobs:    []*github.WorkflowJob{{ID: github.Ptr(int64(200)), RunID: github.Ptr(int64(100))}},
			Usage:   map[int64]*github.WorkflowRunUsage{100: {}},
		},
	}
}

func TestSnapshotRoundTripPlain(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snapshot.json")
	want := testSnapshot()

	if err := WriteSnapshot(path, want); err != nil {
		t.Fatalf("WriteSnapshot: %v", err)
	}
	got, err := ReadSnapshot(path)
	if err != nil {
		t.Fatalf("ReadSnapshot: %v", err)
	}

	if got.Data.Runs[0].GetID() != 100 || got.Data.Jobs[0].GetID() != 200 {
		t.Fatalf("got = %+v, want run 100 and job 200", got.Data)
	}
	if _, ok := got.Data.Usage[100]; !ok {
		t.Fatal("Usage lost its run ID key across the round trip")
	}
}

func TestSnapshotRoundTripGzip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snapshot.json.gz")
	want := testSnapshot()

	if err := WriteSnapshot(path, want); err != nil {
		t.Fatalf("WriteSnapshot: %v", err)
	}
	got, err := ReadSnapshot(path)
	if err != nil {
		t.Fatalf("ReadSnapshot: %v", err)
	}
	if got.Repo.Name != "alpha" {
		t.Fatalf("Repo = %+v, want alpha", got.Repo)
	}
}

func TestSnapshotPreservesHostedPricingInputs(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snapshot.json.gz")
	snap := testSnapshot()
	snap.Data.RunRepositories = map[int64]string{100: "octo/alpha"}
	snap.Data.RepositoryPublic = map[string]bool{"octo/alpha": false}
	snap.Data.HostedRunners = map[string][]*github.HostedRunner{
		"octo": {hostedPool("pool", "linux-x64", "8-core", 8, 32)},
	}
	snap.Data.Jobs[0].Labels = []string{"pool"}
	snap.Data.Usage[100] = usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": {
		Jobs: github.Ptr(1), TotalMS: github.Ptr(int64(61_000)),
		JobRuns: []*github.WorkflowRunJobRun{{JobID: github.Ptr(200), DurationMS: github.Ptr(int64(61_000))}},
	}})
	if err := WriteSnapshot(path, snap); err != nil {
		t.Fatal(err)
	}
	got, err := ReadSnapshot(path)
	if err != nil {
		t.Fatal(err)
	}
	if public, ok := got.Data.RepositoryPublic["octo/alpha"]; !ok || public {
		t.Fatal("private repository visibility was not retained")
	}
	rows, warnings := BuildCostStats(got.Data, nil)
	if len(rows) != 1 || len(warnings) != 0 || rows[0].SKU != "linux_8_core" ||
		rows[0].CPUCores != 8 || rows[0].MemoryGB != 32 || rows[0].Cost == nil || *rows[0].Cost != 0.044 {
		t.Fatalf("rows = %+v; warnings = %v", rows, warnings)
	}
}

func TestReadSnapshotRejectsUnknownVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snapshot.json")
	snap := testSnapshot()
	snap.Version = CurrentSnapshotVersion + 1

	if err := WriteSnapshot(path, snap); err != nil {
		t.Fatalf("WriteSnapshot: %v", err)
	}
	if _, err := ReadSnapshot(path); err == nil {
		t.Fatal("ReadSnapshot accepted an unknown snapshot version")
	}
}

func TestSnapshotRequire(t *testing.T) {
	tests := []struct {
		name     string
		contents SnapshotContents
		jobs     bool
		usage    bool
		wantErr  bool
	}{
		{name: "jobs present", contents: SnapshotContents{Jobs: true}, jobs: true, wantErr: false},
		{name: "jobs missing", contents: SnapshotContents{}, jobs: true, wantErr: true},
		{name: "usage present", contents: SnapshotContents{Usage: true}, usage: true, wantErr: false},
		{name: "usage missing", contents: SnapshotContents{}, usage: true, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			snap := &Snapshot{Contents: tt.contents}
			err := snap.Require(tt.jobs, tt.usage)
			if (err != nil) != tt.wantErr {
				t.Fatalf("Require(%v, %v) error = %v, wantErr %v", tt.jobs, tt.usage, err, tt.wantErr)
			}
		})
	}
}
