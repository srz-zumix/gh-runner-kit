package metrics

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

func viewSnapshot(t *testing.T) *Snapshot {
	t.Helper()
	snapshot := testSnapshot()
	snapshot.Contents.AllAttempts = true
	snapshot.Data.Window = Window{
		Start: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
		End:   time.Date(2026, 10, 4, 0, 0, 0, 0, time.UTC),
	}
	first := snapshot.Data.Window.Start.Add(24 * time.Hour)
	const runID int64 = 9007199254740993
	const jobID int64 = 9007199254740995
	snapshot.Data.Runs = []*github.WorkflowRun{
		{ID: github.Ptr(runID), RunAttempt: github.Ptr(2), CreatedAt: &github.Timestamp{Time: first}},
		{ID: github.Ptr(int64(2)), CreatedAt: &github.Timestamp{Time: first.Add(-time.Nanosecond)}},
		{ID: github.Ptr(int64(3)), CreatedAt: &github.Timestamp{Time: first.Add(24 * time.Hour)}},
		{ID: github.Ptr(int64(4))},
	}
	snapshot.Data.Attempts = []*github.WorkflowRun{
		{ID: github.Ptr(runID), RunAttempt: github.Ptr(1), CreatedAt: &github.Timestamp{Time: snapshot.Data.Window.Start}},
		{ID: github.Ptr(int64(2)), RunAttempt: github.Ptr(1)},
	}
	snapshot.Data.Jobs = []*github.WorkflowJob{
		{ID: github.Ptr(jobID), RunID: github.Ptr(runID), RunAttempt: github.Ptr(int64(2)), Name: github.Ptr(`quoted "9007199254740997"`)},
		{ID: github.Ptr(jobID + 2), RunID: github.Ptr(runID), RunAttempt: github.Ptr(int64(1)), StartedAt: &github.Timestamp{Time: snapshot.Data.Window.Start}},
		{ID: github.Ptr(int64(12)), RunID: github.Ptr(int64(2))},
	}
	snapshot.Data.LatestJobs = map[int64]bool{jobID: true, jobID + 2: false, 12: true}
	snapshot.Data.RunRepositories = map[int64]string{runID: "example/first", 2: "example/second", 3: "example/first", 4: "example/first"}
	snapshot.Data.Repos = []RepoCoverage{
		{Repository: repository.Repository{Owner: "example", Name: "first"}, Runs: 3, Truncated: true},
		{Repository: repository.Repository{Owner: "example", Name: "second"}, Runs: 1},
	}
	snapshot.Data.Usage = map[int64]*github.WorkflowRunUsage{
		runID: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": {TotalMS: github.Ptr(int64(9223372036854775807))}}),
		2:     {},
	}
	snapshot.Data.Warnings = []string{"partial historical coverage"}
	snapshot.Data.Truncated = true
	snapshot.Data.HostedRunners = map[string][]*github.HostedRunner{"example": {hostedPool("pool", "linux-x64", "8-core", 8, 32)}}
	snapshot.Data.RepositoryPublic = map[string]bool{"example/first": false}
	return snapshot
}

func TestSnapshotFilterPreservesExactIDsAndHistoricalCoverage(t *testing.T) {
	snapshot := viewSnapshot(t)
	before, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	window := Window{Start: snapshot.Data.Window.Start.Add(24 * time.Hour), End: snapshot.Data.Window.End.Add(-24 * time.Hour)}
	filtered, err := snapshot.Filter(window)
	if err != nil {
		t.Fatal(err)
	}
	data := filtered.Data
	if len(data.Runs) != 1 || len(data.Attempts) != 1 || len(data.Jobs) != 2 ||
		data.Runs[0].GetID() != 9007199254740993 || data.Attempts[0].GetRunAttempt() != 1 {
		t.Fatalf("incorrect selected runs/attempts/jobs: %+v", data)
	}
	if !data.Jobs[1].GetStartedAt().Before(window.Start) {
		t.Fatal("carried-over job outside the display window was not retained")
	}
	if !reflect.DeepEqual(data.LatestJobs, map[int64]bool{9007199254740995: true, 9007199254740997: false}) ||
		len(data.Usage) != 1 || len(data.RunRepositories) != 1 {
		t.Fatalf("incorrect selected coverage: %+v", data)
	}
	if data.Repos[0].Runs != 1 || data.Repos[1].Runs != 0 || !data.Repos[0].Truncated ||
		!data.Truncated || !reflect.DeepEqual(data.Warnings, snapshot.Data.Warnings) {
		t.Fatal("repository counts or original coverage were lost")
	}
	text, err := json.Marshal(filtered)
	if err != nil {
		t.Fatal(err)
	}
	for _, literal := range []string{`"id":9007199254740995`, `"run_id":9007199254740993`, `"total_ms":9223372036854775807`} {
		if !bytes.Contains(text, []byte(literal)) {
			t.Fatalf("lost exact integer literal %s", literal)
		}
	}
	after, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("filtering mutated the source snapshot")
	}
	if filtered.CreatedAt != snapshot.CreatedAt || filtered.Repo != snapshot.Repo ||
		filtered.Contents != snapshot.Contents || !reflect.DeepEqual(data.Runners, snapshot.Data.Runners) ||
		!reflect.DeepEqual(data.HostedRunners, snapshot.Data.HostedRunners) ||
		!reflect.DeepEqual(data.RepositoryPublic, snapshot.Data.RepositoryPublic) {
		t.Fatal("collection identity or inventory changed")
	}
}

func TestPrepareSnapshotWritesCompactMetadataAndFilteredSnapshots(t *testing.T) {
	snapshot := viewSnapshot(t)
	snapshot.Data.Jobs[0].Name = github.Ptr(strings.Repeat("synthetic-job", 10000))
	directory := t.TempDir()
	input := filepath.Join(directory, "source.json.gz")
	if err := WriteSnapshot(input, snapshot); err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := PrepareSnapshot(input, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(metadata, snapshot.Metadata()) {
		t.Fatal("metadata differs from snapshot inventory and coverage")
	}
	var buf bytes.Buffer
	if err := WriteSnapshotMetadata(&buf, metadata); err != nil {
		t.Fatal(err)
	}
	if buf.Len() > 4096 || bytes.Contains(buf.Bytes(), []byte("synthetic-job")) || bytes.Contains(buf.Bytes(), []byte("total_ms")) {
		t.Fatal("raw job or usage payloads leaked into compact metadata")
	}
	for _, name := range []string{"filtered.json", "filtered.json.gz"} {
		t.Run(name, func(t *testing.T) {
			output := filepath.Join(directory, name)
			metadata, err := PrepareSnapshot(input, output, "2026-10-02", "2026-10-03T00:00:00Z")
			if err != nil {
				t.Fatal(err)
			}
			if metadata.Data.Runs != 1 || metadata.Data.Jobs != 2 || !metadata.Contents.AllAttempts {
				t.Fatalf("incorrect filtered metadata: %+v", metadata)
			}
			saved, err := ReadSnapshot(output)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(saved.Metadata(), metadata) || saved.Data.Jobs[0].GetID() != 9007199254740995 {
				t.Fatal("filtered snapshot and metadata disagree")
			}
			info, err := os.Stat(output)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != snapshotFilePerm {
				t.Fatalf("output permissions = %o", info.Mode().Perm())
			}
		})
	}
	after, err := os.ReadFile(input)
	if err != nil || !bytes.Equal(source, after) {
		t.Fatal("preparing views changed the original snapshot")
	}
	for _, bounds := range [][2]string{{"2026-10-02", ""}, {"", "2026-10-02"}, {"2026-10-02T12:00:00Z", "2026-10-02T13:00:00Z"}} {
		if _, err := PrepareSnapshot(input, "", bounds[0], bounds[1]); err != nil {
			t.Fatalf("one-sided/empty selection failed: %v", err)
		}
	}
}

func TestPrepareSnapshotRejectsInvalidInputAndWindows(t *testing.T) {
	directory := t.TempDir()
	input := filepath.Join(directory, "source.json.gz")
	if err := WriteSnapshot(input, viewSnapshot(t)); err != nil {
		t.Fatal(err)
	}
	for _, bounds := range [][2]string{
		{"invalid", ""}, {"", "invalid"}, {"2026-10-03", "2026-10-02"},
		{"2026-10-02", "2026-10-02"}, {"2026-09-30", ""}, {"", "2026-10-05"},
	} {
		output := filepath.Join(directory, "must-not-exist.json.gz")
		if _, err := PrepareSnapshot(input, output, bounds[0], bounds[1]); err == nil {
			t.Fatalf("accepted invalid bounds %v", bounds)
		}
		if _, err := os.Stat(output); !os.IsNotExist(err) {
			t.Fatal("an invalid view left an output file")
		}
	}
	if _, err := PrepareSnapshot("", "", "", ""); err == nil {
		t.Fatal("accepted an empty input")
	}
	if _, err := PrepareSnapshot(input, "-", "", ""); err == nil {
		t.Fatal("accepted mixing snapshot and metadata on stdout")
	}
	if _, err := PrepareSnapshot(input, filepath.Join(directory, "missing", "out.json"), "", ""); err == nil {
		t.Fatal("suppressed an output write failure")
	}
	for name, text := range map[string]string{
		"version.json": `{"Version":999,"Data":{}}`,
		"empty.json":   `{"Version":1}`,
		"broken.json":  `{"Version":1,"Data":`,
		"tail.json":    `{"Version":1,"Data":{}} {}`,
	} {
		path := filepath.Join(directory, name)
		if err := os.WriteFile(path, []byte(text), snapshotFilePerm); err != nil {
			t.Fatal(err)
		}
		if _, err := PrepareSnapshot(path, "", "", ""); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}
	body, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	body[len(body)-8] ^= 1
	if err := os.WriteFile(input, body, snapshotFilePerm); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareSnapshot(input, "", "", ""); err == nil {
		t.Fatal("accepted a corrupt gzip checksum")
	}
}
