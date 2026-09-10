package metrics

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

type stubJobFetcher struct {
	jobs map[int64][]*github.WorkflowJob
	errs map[int64]error
}

func (f *stubJobFetcher) Jobs(_ context.Context, _ repository.Repository, run *github.WorkflowRun) ([]*github.WorkflowJob, error) {
	if err := f.errs[run.GetID()]; err != nil {
		return nil, err
	}
	return f.jobs[run.GetID()], nil
}

func statusError(status int) error {
	return &github.ErrorResponse{Response: &http.Response{StatusCode: status}}
}

func runWithID(id int64) *github.WorkflowRun {
	return &github.WorkflowRun{ID: github.Ptr(id)}
}

func jobWithID(id int64) *github.WorkflowJob {
	return &github.WorkflowJob{ID: github.Ptr(id)}
}

func TestIsSkippableJobError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{name: "forbidden", err: statusError(http.StatusForbidden), want: true},
		{name: "not found", err: statusError(http.StatusNotFound), want: true},
		{name: "bad gateway", err: statusError(http.StatusBadGateway), want: true},
		{name: "service unavailable", err: statusError(http.StatusServiceUnavailable), want: true},
		{name: "unauthorized", err: statusError(http.StatusUnauthorized), want: false},
		{name: "not an http error", err: errors.New("boom"), want: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isSkippableJobError(tt.err); got != tt.want {
				t.Errorf("isSkippableJobError() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestCollectJobsSkipsServerErrors(t *testing.T) {
	fetcher := &stubJobFetcher{
		jobs: map[int64][]*github.WorkflowJob{
			1: {jobWithID(11)},
			3: {jobWithID(33)},
		},
		errs: map[int64]error{2: statusError(http.StatusBadGateway)},
	}
	repo := repository.Repository{Owner: "o", Name: "r"}
	c := NewCollector(nil, repo, Options{Concurrency: 1}, fetcher)

	jobs, warnings, err := c.collectJobs(context.Background(), repo, []*github.WorkflowRun{runWithID(1), runWithID(2), runWithID(3)})
	if err != nil {
		t.Fatalf("collectJobs() error = %v", err)
	}
	if len(jobs) != 2 {
		t.Errorf("len(jobs) = %d, want 2", len(jobs))
	}
	if len(warnings) != 1 {
		t.Fatalf("len(warnings) = %d, want 1", len(warnings))
	}
	if want := "skipped the jobs of workflow run 2"; !strings.Contains(warnings[0], want) {
		t.Errorf("warnings[0] = %q, want it to contain %q", warnings[0], want)
	}
}

func TestCollectJobsFailsOnUnexpectedError(t *testing.T) {
	fetcher := &stubJobFetcher{errs: map[int64]error{1: statusError(http.StatusUnauthorized)}}
	repo := repository.Repository{Owner: "o", Name: "r"}
	c := NewCollector(nil, repo, Options{Concurrency: 1}, fetcher)

	if _, _, err := c.collectJobs(context.Background(), repo, []*github.WorkflowRun{runWithID(1)}); err == nil {
		t.Fatal("collectJobs() error = nil, want an error")
	}
}
