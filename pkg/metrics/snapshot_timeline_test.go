package metrics

import (
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

func TestSnapshotHistoricalTimelineAndStepOrigin(t *testing.T) {
	start := time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	latest := &github.WorkflowRun{ID: github.Ptr(int64(42)), RunAttempt: github.Ptr(2), Name: github.Ptr("CI"), RunStartedAt: &github.Timestamp{Time: start.Add(time.Hour)}}
	earlier := &github.WorkflowRun{ID: github.Ptr(int64(42)), RunAttempt: github.Ptr(1), Name: github.Ptr("CI"), RunStartedAt: &github.Timestamp{Time: start}}
	job := &github.WorkflowJob{ID: github.Ptr(int64(101)), RunID: github.Ptr(int64(42)), RunAttempt: github.Ptr(int64(1)), Name: github.Ptr("build"),
		StartedAt: &github.Timestamp{Time: start.Add(time.Second)}, CompletedAt: &github.Timestamp{Time: start.Add(time.Minute)},
		Steps: []*github.TaskStep{{Name: github.Ptr("Compile"), Number: github.Ptr(int64(1)), StartedAt: &github.Timestamp{Time: start.Add(time.Second)}, CompletedAt: &github.Timestamp{Time: start.Add(time.Minute)}}}}
	data := &Data{Runs: []*github.WorkflowRun{latest}, Attempts: []*github.WorkflowRun{earlier}, Jobs: []*github.WorkflowJob{job}, RunRepositories: map[int64]string{42: "owner/repo"}}
	snapshot := &Snapshot{Contents: SnapshotContents{Jobs: true, AllAttempts: true}, Repo: repository.Repository{Host: "github.com", Owner: "owner", Name: "repo"}, Data: data}
	timeline, err := BuildSnapshotTimeline(snapshot, RunRef{RunID: 42, Attempt: 1}, TimelineOptions{})
	if err != nil || len(timeline.Jobs) != 1 || timeline.RunAttempt != 1 {
		t.Fatalf("unexpected historical timeline: %#v, %v", timeline, err)
	}
	jobTimeline, err := BuildSnapshotTimeline(snapshot, RunRef{RunID: 42, JobID: 101}, TimelineOptions{})
	if err != nil || jobTimeline.RunAttempt != 1 || len(jobTimeline.Jobs) != 1 {
		t.Fatalf("job reference lost historical attempt: %#v, %v", jobTimeline, err)
	}
	rows := BuildStepRows(data, StepRowOptions{})
	if len(rows) != 1 || rows[0].RunStartedAt == nil || !rows[0].RunStartedAt.Equal(start) {
		t.Fatalf("historical step lost its origin: %#v", rows)
	}
	if _, err := BuildSnapshotTimeline(snapshot, RunRef{RunID: 42, Attempt: 3}, TimelineOptions{}); err == nil {
		t.Fatal("missing attempt was not reported")
	}
	if _, err := BuildSnapshotTimeline(snapshot, RunRef{RunID: 42, Repo: &repository.Repository{Host: "github.com", Owner: "other", Name: "repo"}}, TimelineOptions{}); err == nil {
		t.Fatal("cross-repository reference was accepted")
	}
}
