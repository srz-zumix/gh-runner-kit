package metrics

import (
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

func workflowJob(job *github.WorkflowJob, workflow string, runID int64) *github.WorkflowJob {
	job.WorkflowName = github.Ptr(workflow)
	job.RunID = github.Ptr(runID)
	return job
}

func testWorkflowData() *Data {
	selfHosted := []string{"self-hosted", "linux"}
	return &Data{
		Window:  Window{Start: at(0), End: at(60)},
		Runners: []*github.Runner{testRunner(1, "runner-a", "online", false, selfHosted...)},
		Runs: []*github.WorkflowRun{
			{ID: github.Ptr(int64(1)), RunAttempt: github.Ptr(1)},
			{ID: github.Ptr(int64(2)), RunAttempt: github.Ptr(2)},
			{ID: github.Ptr(int64(3)), RunAttempt: github.Ptr(1)},
		},
		Jobs: []*github.WorkflowJob{
			workflowJob(testJob("build", 1, "runner-a", selfHosted, "success", 0, 5, 15), "CI", 1),
			workflowJob(testJob("build", 1, "runner-a", selfHosted, "failure", 0, 5, 25), "CI", 2),
			workflowJob(testJob("test", 1, "runner-a", selfHosted, "success", 0, 5, 10), "CI", 2),
			workflowJob(testJob("deploy", 0, "", []string{"ubuntu-latest"}, "success", 0, 1, 11), "Release", 3),
		},
		Repos: []repository.Repository{{Host: "github.com", Owner: "octo", Name: "demo"}},
	}
}

func TestBuildWorkflowStats(t *testing.T) {
	rows := BuildWorkflowStats(testWorkflowData(), false)

	if len(rows) != 2 {
		t.Fatalf("len(BuildWorkflowStats()) = %d, want 2", len(rows))
	}

	ci := rows[0]
	if got, want := ci.Workflow, "CI"; got != want {
		t.Fatalf("Workflow = %q, want %q (the busiest workflow comes first)", got, want)
	}
	if got, want := ci.Jobs, 3; got != want {
		t.Fatalf("Jobs = %d, want %d", got, want)
	}
	if got, want := ci.Runs, 2; got != want {
		t.Fatalf("Runs = %d, want %d (runs are counted once even with several jobs)", got, want)
	}
	if got, want := ci.RetryRate, 0.5; got != want {
		t.Fatalf("RetryRate = %v, want %v (one of the two runs was restarted)", got, want)
	}
	if got, want := ci.FailureRate, 1.0/3.0; got != want {
		t.Fatalf("FailureRate = %v, want %v", got, want)
	}
	if got, want := ci.WaitP50, 5*time.Minute; got != want {
		t.Fatalf("WaitP50 = %v, want %v", got, want)
	}
	if got, want := ci.WaitP95, 5*time.Minute; got != want {
		t.Fatalf("WaitP95 = %v, want %v", got, want)
	}

	release := rows[1]
	if got, want := release.Workflow, "Release"; got != want {
		t.Fatalf("Workflow = %q, want %q", got, want)
	}
	if got, want := release.RetryRate, 0.0; got != want {
		t.Fatalf("RetryRate = %v, want %v", got, want)
	}
}

func TestBuildWorkflowStatsSelfHostedOnly(t *testing.T) {
	rows := BuildWorkflowStats(testWorkflowData(), true)

	if len(rows) != 1 {
		t.Fatalf("len(BuildWorkflowStats()) = %d, want 1 (the hosted workflow is dropped)", len(rows))
	}
	if got, want := rows[0].Workflow, "CI"; got != want {
		t.Fatalf("Workflow = %q, want %q", got, want)
	}
}

// TestBuildWorkflowStatsSeparatesSameNameDifferentFile ensures two distinct workflow
// files that happen to share a display name are not merged into a single row.
func TestBuildWorkflowStatsSeparatesSameNameDifferentFile(t *testing.T) {
	selfHosted := []string{"self-hosted", "linux"}
	data := &Data{
		Window:  Window{Start: at(0), End: at(60)},
		Runners: []*github.Runner{testRunner(1, "runner-a", "online", false, selfHosted...)},
		Runs: []*github.WorkflowRun{
			{ID: github.Ptr(int64(1)), RunAttempt: github.Ptr(1), WorkflowID: github.Ptr(int64(100)), Path: github.Ptr(".github/workflows/a.yml")},
			{ID: github.Ptr(int64(2)), RunAttempt: github.Ptr(1), WorkflowID: github.Ptr(int64(200)), Path: github.Ptr(".github/workflows/b.yml")},
		},
		Jobs: []*github.WorkflowJob{
			workflowJob(testJob("build", 1, "runner-a", selfHosted, "success", 0, 5, 15), "CI", 1),
			workflowJob(testJob("build", 1, "runner-a", selfHosted, "success", 0, 5, 15), "CI", 2),
		},
		RunRepositories: map[int64]string{1: "octo/demo", 2: "octo/demo"},
	}

	rows := BuildWorkflowStats(data, false)
	if len(rows) != 2 {
		t.Fatalf("len(BuildWorkflowStats()) = %d, want 2 (same name but different workflow files must not merge)", len(rows))
	}
	for _, row := range rows {
		if row.Workflow != "CI" {
			t.Fatalf("Workflow = %q, want %q", row.Workflow, "CI")
		}
	}
	if rows[0].WorkflowPath == rows[1].WorkflowPath {
		t.Fatalf("WorkflowPath = %q for both rows, want distinct paths", rows[0].WorkflowPath)
	}
}

// TestBuildWorkflowStatsSeparatesSameNameDifferentRepo ensures equally named workflows of
// different repositories stay in distinct rows, which matters under --all-repos.
func TestBuildWorkflowStatsSeparatesSameNameDifferentRepo(t *testing.T) {
	selfHosted := []string{"self-hosted", "linux"}
	data := &Data{
		Window:  Window{Start: at(0), End: at(60)},
		Runners: []*github.Runner{testRunner(1, "runner-a", "online", false, selfHosted...)},
		Runs: []*github.WorkflowRun{
			{ID: github.Ptr(int64(1)), RunAttempt: github.Ptr(1)},
			{ID: github.Ptr(int64(2)), RunAttempt: github.Ptr(1)},
		},
		Jobs: []*github.WorkflowJob{
			workflowJob(testJob("build", 1, "runner-a", selfHosted, "success", 0, 5, 15), "CI", 1),
			workflowJob(testJob("build", 1, "runner-a", selfHosted, "success", 0, 5, 15), "CI", 2),
		},
		RunRepositories: map[int64]string{1: "octo/a", 2: "octo/b"},
	}

	rows := BuildWorkflowStats(data, false)
	if len(rows) != 2 {
		t.Fatalf("len(BuildWorkflowStats()) = %d, want 2 (same name in different repositories must not merge)", len(rows))
	}
	if rows[0].Repository == rows[1].Repository {
		t.Fatalf("Repository = %q for both rows, want distinct repositories", rows[0].Repository)
	}
}
