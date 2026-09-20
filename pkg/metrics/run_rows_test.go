package metrics

import (
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

func TestBuildRunRows(t *testing.T) {
	created := time.Date(2026, 9, 20, 1, 2, 3, 0, time.UTC)
	started := created.Add(time.Minute)
	updated := started.Add(time.Hour)
	data := &Data{
		Runs: []*github.WorkflowRun{
			{ID: github.Ptr(int64(2)), Name: github.Ptr("late"), CreatedAt: &github.Timestamp{Time: created.Add(time.Minute)}},
			{
				ID: github.Ptr(int64(1)), Name: github.Ptr("build"), Path: github.Ptr(".github/workflows/build.yml"),
				WorkflowID: github.Ptr(int64(42)), RunNumber: github.Ptr(7), RunAttempt: github.Ptr(2),
				Event: github.Ptr("push"), HeadBranch: github.Ptr("main"), HeadSHA: github.Ptr("abc123"),
				Status: github.Ptr("completed"), Conclusion: github.Ptr("success"),
				CreatedAt: &github.Timestamp{Time: created}, RunStartedAt: &github.Timestamp{Time: started},
				UpdatedAt: &github.Timestamp{Time: updated}, HTMLURL: github.Ptr("https://example.test/runs/1"),
			},
		},
		RunRepositories: map[int64]string{1: "octo/demo", 2: "octo/demo"},
		Repos:           []RepoCoverage{{Repository: repository.Repository{Owner: "octo", Name: "demo"}, Runs: 2}},
	}

	rows := BuildRunRows(data)
	if len(rows) != 2 || rows[0].RunID != 1 || rows[1].RunID != 2 {
		t.Fatalf("run order = %#v, want [1 2]", rows)
	}
	row := rows[0]
	if row.Repository != "octo/demo" || row.WorkflowPath != ".github/workflows/build.yml" || row.RunAttempt != 2 {
		t.Fatalf("row metadata = %#v", row)
	}
	if row.StartedAt == nil || !row.StartedAt.Equal(started) || row.UpdatedAt == nil || !row.UpdatedAt.Equal(updated) {
		t.Fatalf("timestamps = %#v", row)
	}
}
