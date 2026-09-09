package metrics

import (
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

func ts(minute int) github.Timestamp {
	return github.Timestamp{Time: at(minute)}
}

func testJob(name string, runnerID int64, runnerName string, labels []string, conclusion string, queued, started, completed int) *github.WorkflowJob {
	return &github.WorkflowJob{
		Name:        github.Ptr(name),
		RunID:       github.Ptr(int64(1)),
		Status:      github.Ptr("completed"),
		Conclusion:  github.Ptr(conclusion),
		RunnerID:    github.Ptr(runnerID),
		RunnerName:  github.Ptr(runnerName),
		Labels:      labels,
		CreatedAt:   github.Ptr(ts(queued)),
		StartedAt:   github.Ptr(ts(started)),
		CompletedAt: github.Ptr(ts(completed)),
	}
}

func testRunner(id int64, name, status string, busy bool, labels ...string) *github.Runner {
	runnerLabels := make([]*github.RunnerLabels, 0, len(labels))
	for _, label := range labels {
		runnerLabels = append(runnerLabels, &github.RunnerLabels{Name: github.Ptr(label)})
	}
	return &github.Runner{
		ID:     github.Ptr(id),
		Name:   github.Ptr(name),
		Status: github.Ptr(status),
		Busy:   github.Ptr(busy),
		Labels: runnerLabels,
	}
}

func testData() *Data {
	return &Data{
		Window: Window{Start: at(0), End: at(60)},
		Runners: []*github.Runner{
			testRunner(1, "runner-a", "online", false, "self-hosted", "linux"),
			testRunner(2, "runner-b", "offline", false, "self-hosted", "linux"),
			testRunner(3, "runner-c", "online", true, "self-hosted", "linux", "cordoned"),
		},
		Runs: []*github.WorkflowRun{{ID: github.Ptr(int64(1))}},
		Jobs: []*github.WorkflowJob{
			testJob("build", 1, "runner-a", []string{"self-hosted", "linux"}, "success", 0, 5, 15),
			testJob("test", 1, "runner-a", []string{"self-hosted", "linux"}, "failure", 10, 20, 30),
			testJob("lint", 2, "runner-b", []string{"self-hosted", "linux"}, "success", 0, 10, 20),
			testJob("deploy", 0, "", []string{"ubuntu-latest"}, "success", 0, 1, 41),
			testJob("docs", 0, "", []string{"self-hosted", "linux"}, "skipped", 0, 0, 0),
			// A check run published by an app, which the jobs API returns without labels.
			testJob("actionlint", 0, "", nil, "success", 5, 5, 5),
		},
		Repos: []repository.Repository{{Host: "github.com", Owner: "octo", Name: "demo"}},
	}
}

func TestNewJobs(t *testing.T) {
	jobs := NewJobs(testData())

	if got, want := len(jobs), 4; got != want {
		t.Fatalf("len(NewJobs()) = %d, want %d (skipped jobs, unfinished jobs and check runs are dropped)", got, want)
	}

	build := jobs[0]
	if got, want := build.Wait(), 5*time.Minute; got != want {
		t.Fatalf("Wait() = %v, want %v", got, want)
	}
	if got, want := build.Duration(), 10*time.Minute; got != want {
		t.Fatalf("Duration() = %v, want %v", got, want)
	}
	if got, want := build.Kind, JobKindSelfHosted; got != want {
		t.Fatalf("Kind = %q, want %q", got, want)
	}
}

func TestFleetJobs(t *testing.T) {
	fleet := FleetJobs(NewJobs(testData()))

	if got, want := len(fleet), 3; got != want {
		t.Fatalf("len(FleetJobs()) = %d, want %d (hosted jobs are excluded)", got, want)
	}
	for _, job := range fleet {
		if job.Kind == JobKindHosted {
			t.Fatalf("FleetJobs() returned a hosted job: %+v", job)
		}
	}
}

func TestBuildSummary(t *testing.T) {
	s := BuildSummary(testData())

	if got, want := s.Runners, 3; got != want {
		t.Fatalf("Runners = %d, want %d", got, want)
	}
	if got, want := s.Online, 2; got != want {
		t.Fatalf("Online = %d, want %d", got, want)
	}
	if got, want := s.Busy, 1; got != want {
		t.Fatalf("Busy = %d, want %d", got, want)
	}
	if got, want := s.Cordoned, 1; got != want {
		t.Fatalf("Cordoned = %d, want %d", got, want)
	}
	if got, want := s.Jobs, 3; got != want {
		t.Fatalf("Jobs = %d, want %d", got, want)
	}
	if got, want := s.HostedJobs, 1; got != want {
		t.Fatalf("HostedJobs = %d, want %d", got, want)
	}
	// build 10m + test 10m + lint 10m
	if got, want := s.BusyTime, 30*time.Minute; got != want {
		t.Fatalf("BusyTime = %v, want %v", got, want)
	}
	// build and lint overlap between minute 10 and 15.
	if got, want := s.PeakConcurrency, 2; got != want {
		t.Fatalf("PeakConcurrency = %d, want %d", got, want)
	}
	// one failure out of three decided jobs
	if got, want := s.FailureRate, 1.0/3.0; got != want {
		t.Fatalf("FailureRate = %v, want %v", got, want)
	}
	// 30m busy over a 60m window shared by 3 runners
	if got, want := s.Utilization, 30.0/180.0; got != want {
		t.Fatalf("Utilization = %v, want %v", got, want)
	}
}

func TestBuildSummaryClampsBusyTimeToWindow(t *testing.T) {
	data := testData()
	data.Window = Window{Start: at(10), End: at(20)}

	s := BuildSummary(data)
	// build contributes 10-15, test contributes nothing, lint contributes 10-20.
	if got, want := s.BusyTime, 15*time.Minute; got != want {
		t.Fatalf("BusyTime = %v, want %v", got, want)
	}
}

func TestBuildRunnerStats(t *testing.T) {
	rows := BuildRunnerStats(testData(), GroupByName)

	if got, want := len(rows), 3; got != want {
		t.Fatalf("len(rows) = %d, want %d (idle runners keep a row)", got, want)
	}

	byKey := map[string]RunnerRow{}
	for _, row := range rows {
		byKey[row.Key] = row
	}

	a := byKey["runner-a"]
	if got, want := a.Jobs, 2; got != want {
		t.Fatalf("runner-a jobs = %d, want %d", got, want)
	}
	if got, want := a.BusyTime, 20*time.Minute; got != want {
		t.Fatalf("runner-a busy = %v, want %v", got, want)
	}
	if got, want := a.FailureRate, 0.5; got != want {
		t.Fatalf("runner-a failure rate = %v, want %v", got, want)
	}
	if got, want := a.Status, "online"; got != want {
		t.Fatalf("runner-a status = %q, want %q", got, want)
	}

	c := byKey["runner-c"]
	if got, want := c.Jobs, 0; got != want {
		t.Fatalf("runner-c jobs = %d, want %d", got, want)
	}
	if !c.Cordoned {
		t.Fatal("runner-c should be reported as cordoned")
	}

	if rows[0].Key != "runner-a" {
		t.Fatalf("rows[0].Key = %q, want the busiest runner first", rows[0].Key)
	}
}

func TestBuildRunnerStatsGroupByLabel(t *testing.T) {
	rows := BuildRunnerStats(testData(), GroupByLabel)

	if got, want := len(rows), 1; got != want {
		t.Fatalf("len(rows) = %d, want %d", got, want)
	}
	if got, want := rows[0].Key, "linux,self-hosted"; got != want {
		t.Fatalf("Key = %q, want %q", got, want)
	}
	if got, want := rows[0].Jobs, 3; got != want {
		t.Fatalf("Jobs = %d, want %d", got, want)
	}
}

func TestBuildQueueStats(t *testing.T) {
	rows := BuildQueueStats(testData())

	if got, want := len(rows), 1; got != want {
		t.Fatalf("len(rows) = %d, want %d", got, want)
	}

	row := rows[0]
	if got, want := row.LabelSet(), "linux,self-hosted"; got != want {
		t.Fatalf("LabelSet() = %q, want %q", got, want)
	}
	if got, want := row.Jobs, 3; got != want {
		t.Fatalf("Jobs = %d, want %d", got, want)
	}
	// waits are 5m, 10m and 10m
	if got, want := row.WaitP50, 10*time.Minute; got != want {
		t.Fatalf("WaitP50 = %v, want %v", got, want)
	}
	if got, want := row.WaitMax, 10*time.Minute; got != want {
		t.Fatalf("WaitMax = %v, want %v", got, want)
	}
	if got, want := row.Runners, 3; got != want {
		t.Fatalf("Runners = %d, want %d", got, want)
	}
	if got, want := row.PeakConcurrency, 2; got != want {
		t.Fatalf("PeakConcurrency = %d, want %d", got, want)
	}
	if got, want := row.Saturation, 2.0/3.0; got != want {
		t.Fatalf("Saturation = %v, want %v", got, want)
	}
}
