package metrics

import (
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

func TestParseRunRef(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    RunRef
		wantErr bool
	}{
		{name: "run ID", input: "12345", want: RunRef{RunID: 12345}},
		{name: "run ID with spaces", input: " 42 ", want: RunRef{RunID: 42}},
		{
			name:  "run URL",
			input: "https://github.com/octo/app/actions/runs/99",
			want:  RunRef{Repo: &repository.Repository{Host: "github.com", Owner: "octo", Name: "app"}, RunID: 99},
		},
		{
			name:  "attempt URL on GHES",
			input: "https://ghe.example.com/octo/app/actions/runs/99/attempts/3",
			want:  RunRef{Repo: &repository.Repository{Host: "ghe.example.com", Owner: "octo", Name: "app"}, RunID: 99, Attempt: 3},
		},
		{
			name:  "job URL with query",
			input: "https://github.com/octo/app/actions/runs/99/job/7?pr=1",
			want:  RunRef{Repo: &repository.Repository{Host: "github.com", Owner: "octo", Name: "app"}, RunID: 99, JobID: 7},
		},
		{
			name:  "attempt job URL",
			input: "https://github.com/octo/app/actions/runs/99/attempts/2/job/7",
			want:  RunRef{Repo: &repository.Repository{Host: "github.com", Owner: "octo", Name: "app"}, RunID: 99, Attempt: 2, JobID: 7},
		},
		{
			name:  "workflow page",
			input: "https://github.com/octo/app/actions/runs/99/workflow",
			want:  RunRef{Repo: &repository.Repository{Host: "github.com", Owner: "octo", Name: "app"}, RunID: 99},
		},
		{name: "empty", input: "", wantErr: true},
		{name: "zero ID", input: "0", wantErr: true},
		{name: "negative ID", input: "-1", wantErr: true},
		{name: "not a number", input: "abc", wantErr: true},
		{name: "pull request URL", input: "https://github.com/octo/app/pull/1", wantErr: true},
		{name: "invalid run ID", input: "https://github.com/octo/app/actions/runs/x", wantErr: true},
		{name: "invalid attempt", input: "https://github.com/octo/app/actions/runs/1/attempts/0", wantErr: true},
		{name: "too many segments", input: "https://github.com/octo/app/actions/runs/1/job/2/extra/more", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseRunRef(tt.input)
			if tt.wantErr {
				if err == nil {
					t.Fatalf("ParseRunRef(%q) = %+v, want error", tt.input, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseRunRef(%q) error = %v", tt.input, err)
			}
			if got.RunID != tt.want.RunID || got.Attempt != tt.want.Attempt || got.JobID != tt.want.JobID {
				t.Errorf("ParseRunRef(%q) = %+v, want %+v", tt.input, got, tt.want)
			}
			if (got.Repo == nil) != (tt.want.Repo == nil) || (got.Repo != nil && *got.Repo != *tt.want.Repo) {
				t.Errorf("ParseRunRef(%q).Repo = %v, want %v", tt.input, got.Repo, tt.want.Repo)
			}
		})
	}
}

func timelineFixture() (*github.WorkflowRun, []*github.WorkflowJob) {
	run := &github.WorkflowRun{
		ID:           github.Ptr(int64(1)),
		Name:         github.Ptr("CI"),
		RunAttempt:   github.Ptr(2),
		RunStartedAt: github.Ptr(sec(10)),
		HTMLURL:      github.Ptr("https://github.com/octo/app/actions/runs/1/attempts/2"),
		Status:       github.Ptr("completed"),
		Conclusion:   github.Ptr("failure"),
	}
	test := testStepJob(12, 1, 2, "test", "failure", 30, 60,
		testStep(2, "Run tests", "failure", 32, 60),
		testStep(1, "Set up job", "success", 30, 32),
	)
	build := testStepJob(11, 1, 2, "build", "success", 15, 40,
		testStep(1, "Set up job", "success", 15, 16),
		testStep(2, "Upload", "success", 16, 20),
		testStep(3, "Upload", "success", 20, 40),
	)
	// The first attempt's job must not stretch the axis back to second 0.
	old := testStepJob(5, 1, 1, "lint", "success", 0, 5)
	return run, []*github.WorkflowJob{test, old, build}
}

func TestBuildRunTimeline(t *testing.T) {
	run, jobs := timelineFixture()
	repo := repository.Repository{Host: "github.com", Owner: "octo", Name: "app"}
	tl := BuildRunTimeline(repo, run, jobs, TimelineOptions{})

	if tl.Repo != "octo/app" || tl.RunAttempt != 2 || tl.Workflow != "CI" {
		t.Fatalf("unexpected run identity: %+v", tl)
	}
	// The build job was queued 5s before it started, at second 10, which is also when
	// the attempt started.
	if tl.StartedAt == nil || !tl.StartedAt.Equal(sec(10).Time) {
		t.Fatalf("StartedAt = %v, want %v", tl.StartedAt, sec(10).Time)
	}
	if tl.Duration != 50*time.Second {
		t.Errorf("Duration = %v, want 50s", tl.Duration)
	}
	if len(tl.Jobs) != 2 || tl.Jobs[0].Name != "build" || tl.Jobs[1].Name != "test" {
		t.Fatalf("jobs = %+v, want build then test", tl.Jobs)
	}

	build := tl.Jobs[0]
	if build.QueuedOffset != 0 || build.StartedOffset != 5*time.Second || build.Wait != 5*time.Second || build.Duration != 25*time.Second {
		t.Errorf("build offsets = queued %v started %v wait %v duration %v", build.QueuedOffset, build.StartedOffset, build.Wait, build.Duration)
	}
	if len(build.Steps) != 3 || build.Steps[2].Key != "Upload #2" {
		t.Fatalf("build steps = %+v", build.Steps)
	}
	if s := build.Steps[2]; s.Offset != 10*time.Second || s.JobOffset != 5*time.Second || s.Duration != 20*time.Second {
		t.Errorf("Upload #2 = offset %v job offset %v duration %v", s.Offset, s.JobOffset, s.Duration)
	}

	test := tl.Jobs[1]
	if test.Steps[0].Name != "Set up job" || test.Steps[1].Conclusion != "failure" {
		t.Errorf("test steps are not ordered by number: %+v", test.Steps)
	}
}

func TestBuildRunTimelineFallsBackToJobsForOrigin(t *testing.T) {
	run, jobs := timelineFixture()
	run.RunStartedAt = nil
	tl := BuildRunTimeline(repository.Repository{Owner: "octo", Name: "app"}, run, jobs, TimelineOptions{})
	if tl.StartedAt == nil || !tl.StartedAt.Equal(sec(10).Time) {
		t.Fatalf("StartedAt = %v, want the earliest queued job at %v", tl.StartedAt, sec(10).Time)
	}
}

func TestBuildRunTimelineFilters(t *testing.T) {
	run, jobs := timelineFixture()
	repo := repository.Repository{Owner: "octo", Name: "app"}

	tl := BuildRunTimeline(repo, run, jobs, TimelineOptions{Jobs: []string{"te*"}})
	if len(tl.Jobs) != 1 || tl.Jobs[0].Name != "test" {
		t.Errorf("--job te* kept %+v", tl.Jobs)
	}

	tl = BuildRunTimeline(repo, run, jobs, TimelineOptions{JobID: 11})
	if len(tl.Jobs) != 1 || tl.Jobs[0].JobID != 11 {
		t.Errorf("job ID 11 kept %+v", tl.Jobs)
	}

	if err := (TimelineOptions{Jobs: []string{""}}).Validate(); err == nil {
		t.Error("an empty --job pattern must be rejected")
	}
}

func TestJobAttempt(t *testing.T) {
	job := &github.WorkflowJob{ID: github.Ptr(int64(7)), RunID: github.Ptr(int64(42)), RunAttempt: github.Ptr(int64(1))}
	got, err := JobAttempt(job, 42)
	if err != nil || got != 1 {
		t.Fatalf("JobAttempt() = %d, %v, want 1, nil", got, err)
	}
	if _, err := JobAttempt(job, 43); err == nil {
		t.Fatal("JobAttempt() accepted a job of another run")
	}
}
