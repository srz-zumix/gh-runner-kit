package metrics

import (
	"testing"
	"time"

	"github.com/google/go-github/v90/github"
)

// queuedJobData adds a job that has been queued but never picked up, which the
// aggregated reports drop and the listing keeps.
func queuedJobData() *Data {
	data := testData()
	data.Jobs = append(data.Jobs, &github.WorkflowJob{
		ID:         github.Ptr(int64(99)),
		RunID:      github.Ptr(int64(1)),
		Name:       github.Ptr("pending"),
		Status:     github.Ptr("queued"),
		RunnerName: github.Ptr(""),
		Labels:     []string{"self-hosted", "linux"},
		CreatedAt:  github.Ptr(ts(2)),
	})
	return data
}

func jobNames(rows []JobRow) []string {
	names := make([]string, 0, len(rows))
	for _, row := range rows {
		names = append(names, row.JobName)
	}
	return names
}

func TestBuildJobRows(t *testing.T) {
	cases := []struct {
		name string
		opts JobRowOptions
		want []string
	}{
		{
			name: "every job, ordered by the instant it started",
			want: []string{"docs", "deploy", "build", "lint", "test"},
		},
		{
			name: "self-hosted only",
			opts: JobRowOptions{Kind: JobKindFilterSelfHosted},
			want: []string{"docs", "build", "lint", "test"},
		},
		{
			name: "github-hosted only",
			opts: JobRowOptions{Kind: JobKindFilterHosted},
			want: []string{"deploy"},
		},
		{
			name: "label filter keeps the jobs carrying every label",
			opts: JobRowOptions{Labels: []string{"self-hosted", "linux"}},
			want: []string{"docs", "build", "lint", "test"},
		},
		{
			name: "runner patterns are matched as a union",
			opts: JobRowOptions{Runners: []string{"runner-a", "runner-b"}},
			want: []string{"build", "lint", "test"},
		},
		{
			name: "runner wildcard",
			opts: JobRowOptions{Runners: []string{"runner-*"}},
			want: []string{"build", "lint", "test"},
		},
		{
			name: "runner and label filters are combined",
			opts: JobRowOptions{Runners: []string{"runner-a"}, Labels: []string{"linux"}},
			want: []string{"build", "test"},
		},
		{
			name: "excluded runners are dropped",
			opts: JobRowOptions{ExcludeRunners: []string{"runner-a"}},
			want: []string{"docs", "deploy", "lint"},
		},
		{
			name: "exclusion wildcard drops every matching runner",
			opts: JobRowOptions{ExcludeRunners: []string{"runner-*"}},
			want: []string{"docs", "deploy"},
		},
		{
			name: "exclusion wins over inclusion",
			opts: JobRowOptions{Runners: []string{"runner-*"}, ExcludeRunners: []string{"runner-b"}},
			want: []string{"build", "test"},
		},
		{
			name: "limit caps the rows after filtering",
			opts: JobRowOptions{Kind: JobKindFilterSelfHosted, Limit: 2},
			want: []string{"docs", "build"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := jobNames(BuildJobRows(testData(), tc.opts))
			if len(got) != len(tc.want) {
				t.Fatalf("BuildJobRows() = %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("BuildJobRows() = %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestBuildJobRowsFields(t *testing.T) {
	rows := BuildJobRows(testData(), JobRowOptions{Runners: []string{"runner-a"}, Labels: []string{"linux"}})
	if len(rows) != 2 {
		t.Fatalf("len(BuildJobRows()) = %d, want 2", len(rows))
	}

	build := rows[0]
	if got, want := build.Wait, 5*time.Minute; got != want {
		t.Fatalf("Wait = %v, want %v", got, want)
	}
	if got, want := build.Duration, 10*time.Minute; got != want {
		t.Fatalf("Duration = %v, want %v", got, want)
	}
	if got, want := build.Kind, JobKindSelfHosted; got != want {
		t.Fatalf("Kind = %q, want %q", got, want)
	}
	if build.StartedAt == nil || !build.StartedAt.Equal(at(5)) {
		t.Fatalf("StartedAt = %v, want %v", build.StartedAt, at(5))
	}
}

func TestNormalizeRunnerName(t *testing.T) {
	cases := []struct {
		name     string
		runner   string
		runnerID int64
		want     string
	}{
		{"hosted name drops the id", "GitHub Actions 1000299771", 1000299771, "GitHub Actions"},
		{"a different id is not the hosted form", "GitHub Actions 1000299771", 42, "GitHub Actions 1000299771"},
		{"self-hosted name ending in a number is kept", "runner-1", 1, "runner-1"},
		{"unknown runner", "", 0, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeRunnerName(tc.runner, tc.runnerID); got != tc.want {
				t.Fatalf("normalizeRunnerName(%q, %d) = %q, want %q", tc.runner, tc.runnerID, got, tc.want)
			}
		})
	}
}

func TestBuildJobRowsNormalizesHostedRunnerName(t *testing.T) {
	data := testData()
	for _, job := range data.Jobs {
		if job.GetName() == "deploy" {
			job.RunnerID = github.Ptr(int64(1000299771))
			job.RunnerName = github.Ptr("GitHub Actions 1000299771")
		}
	}

	rows := BuildJobRows(data, JobRowOptions{Kind: JobKindFilterHosted})
	if len(rows) != 1 {
		t.Fatalf("len(BuildJobRows()) = %d, want 1", len(rows))
	}
	if got, want := rows[0].RunnerName, "GitHub Actions"; got != want {
		t.Fatalf("RunnerName = %q, want %q", got, want)
	}
	if got, want := rows[0].RunnerID, int64(1000299771); got != want {
		t.Fatalf("RunnerID = %d, want %d (the id stays available)", got, want)
	}
}

func TestBuildJobRowsKeepsSkippedJobsAndDropsCheckRuns(t *testing.T) {
	rows := BuildJobRows(testData(), JobRowOptions{})

	var skipped, checkRun bool
	for _, row := range rows {
		switch row.JobName {
		case "docs":
			skipped = true
		case "actionlint":
			checkRun = true
		}
	}
	if !skipped {
		t.Fatalf("BuildJobRows() = %v, want the skipped job to be listed", jobNames(rows))
	}
	if checkRun {
		t.Fatalf("BuildJobRows() = %v, want the check run to be dropped", jobNames(rows))
	}
}

func TestBuildJobRowsKeepsQueuedJobs(t *testing.T) {
	rows := BuildJobRows(queuedJobData(), JobRowOptions{})

	last := rows[len(rows)-1]
	if got, want := last.JobName, "pending"; got != want {
		t.Fatalf("last job = %q, want %q (jobs that never started sort last)", got, want)
	}
	if last.StartedAt != nil || last.CompletedAt != nil {
		t.Fatalf("StartedAt = %v, CompletedAt = %v, want both unset", last.StartedAt, last.CompletedAt)
	}
	if last.QueuedAt == nil || !last.QueuedAt.Equal(at(2)) {
		t.Fatalf("QueuedAt = %v, want %v", last.QueuedAt, at(2))
	}
	if last.Wait != 0 || last.Duration != 0 {
		t.Fatalf("Wait = %v, Duration = %v, want both 0", last.Wait, last.Duration)
	}
}

func TestJobRowOptionsValidate(t *testing.T) {
	cases := []struct {
		name    string
		opts    JobRowOptions
		wantErr bool
	}{
		{name: "empty"},
		{name: "wildcard pattern", opts: JobRowOptions{Runners: []string{"i-0*"}}},
		{name: "malformed pattern", opts: JobRowOptions{Runners: []string{"[a-"}}, wantErr: true},
		{name: "malformed exclusion pattern", opts: JobRowOptions{ExcludeRunners: []string{"[a-"}}, wantErr: true},
		{name: "negative limit", opts: JobRowOptions{Limit: -1}, wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.opts.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate() error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}
