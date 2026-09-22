package metrics

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
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

func runCreatedAt(id int64, at time.Time) *github.WorkflowRun {
	return &github.WorkflowRun{ID: github.Ptr(id), CreatedAt: &github.Timestamp{Time: at}}
}

func TestSelectWindowRuns(t *testing.T) {
	start := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	window := Window{Start: start, End: start.AddDate(0, 0, 1)}
	inside := runCreatedAt(1, start.Add(time.Hour))
	before := runCreatedAt(2, start.Add(-time.Hour))

	tests := []struct {
		name          string
		runs          []*github.WorkflowRun
		limit         int
		wantKept      int
		wantTruncated bool
	}{
		{name: "drops the runs outside the window", runs: []*github.WorkflowRun{inside, before}, limit: 0, wantKept: 1},
		{name: "reports a spent limit the kept count hides", runs: []*github.WorkflowRun{inside, before}, limit: 2, wantKept: 1, wantTruncated: true},
		{name: "keeps quiet below the limit", runs: []*github.WorkflowRun{inside}, limit: 2, wantKept: 1},
		{name: "never truncates without a limit", runs: []*github.WorkflowRun{inside, before}, limit: 0, wantKept: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kept, truncated := selectWindowRuns(window, tt.runs, tt.limit)
			if len(kept) != tt.wantKept {
				t.Errorf("len(kept) = %d, want %d", len(kept), tt.wantKept)
			}
			if truncated != tt.wantTruncated {
				t.Errorf("truncated = %v, want %v", truncated, tt.wantTruncated)
			}
		})
	}
}

func TestDataTruncatedRepos(t *testing.T) {
	data := &Data{Repos: []RepoCoverage{
		{Repository: repository.Repository{Owner: "o", Name: "a"}, Runs: 300, Truncated: true},
		{Repository: repository.Repository{Owner: "o", Name: "b"}, Runs: 12},
		{Repository: repository.Repository{Owner: "o", Name: "c"}, Runs: 300, Truncated: true},
	}}

	if got := data.TruncatedRepos(); got != 2 {
		t.Errorf("TruncatedRepos() = %d, want 2", got)
	}
	if got := data.Repos[1].FullName(); got != "o/b" {
		t.Errorf("FullName() = %q, want %q", got, "o/b")
	}
}

func TestFilterRepositories(t *testing.T) {
	repos := []repository.Repository{
		{Host: "github.com", Owner: "octo", Name: "api"},
		{Host: "github.com", Owner: "octo", Name: "web"},
		{Host: "github.com", Owner: "other", Name: "docs"},
	}

	got, err := filterRepositories(repos, []string{"octo/*"}, []string{"octo/web"})
	if err != nil {
		t.Fatalf("filterRepositories() error = %v", err)
	}
	if len(got) != 1 || parser.GetRepositoryFullName(got[0]) != "octo/api" {
		t.Fatalf("filterRepositories() = %#v, want only octo/api", got)
	}

	if _, err := filterRepositories(repos, []string{"infra/*"}, nil); err == nil {
		t.Fatal("filterRepositories() error = nil, want a no-match error")
	}
}

func TestValidateRepositoryPatterns(t *testing.T) {
	if err := (Options{IncludeRepos: []string{"octo/*"}, ExcludeRepos: []string{"octo/web"}}).ValidateRepositoryPatterns(); err != nil {
		t.Fatalf("ValidateRepositoryPatterns() error = %v, want nil", err)
	}
	if err := (Options{IncludeRepos: []string{"octo/["}}).ValidateRepositoryPatterns(); err == nil {
		t.Fatal("ValidateRepositoryPatterns() error = nil, want an error for the malformed --include-repo pattern")
	}
	if err := (Options{ExcludeRepos: []string{"octo/["}}).ValidateRepositoryPatterns(); err == nil {
		t.Fatal("ValidateRepositoryPatterns() error = nil, want an error for the malformed --exclude-repo pattern")
	}
}

func TestIsSkippableRunRequestError(t *testing.T) {
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
			if got := isSkippableRunRequestError(tt.err); got != tt.want {
				t.Errorf("isSkippableRunRequestError() = %v, want %v", got, tt.want)
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

type stubUsageFetcher struct {
	usage map[int64]*github.WorkflowRunUsage
	errs  map[int64]error
}

func (f *stubUsageFetcher) Usage(_ context.Context, _ repository.Repository, run *github.WorkflowRun) (*github.WorkflowRunUsage, error) {
	if err := f.errs[run.GetID()]; err != nil {
		return nil, err
	}
	return f.usage[run.GetID()], nil
}

func usageWithBillable(ms int64) *github.WorkflowRunUsage {
	return &github.WorkflowRunUsage{
		Billable: &github.WorkflowRunBillMap{
			"UBUNTU": &github.WorkflowRunBill{TotalMS: github.Ptr(ms)},
		},
	}
}

func TestCollectUsageCollectsPerRun(t *testing.T) {
	fetcher := &stubUsageFetcher{
		usage: map[int64]*github.WorkflowRunUsage{
			1: usageWithBillable(1000),
			2: usageWithBillable(2000),
		},
	}
	repo := repository.Repository{Owner: "o", Name: "r"}
	c := NewCollector(nil, repo, Options{Concurrency: 1}, nil)
	c.SetUsageFetcher(fetcher)

	usage, warnings, err := c.collectUsage(context.Background(), repo, []*github.WorkflowRun{runWithID(1), runWithID(2)})
	if err != nil {
		t.Fatalf("collectUsage() error = %v", err)
	}
	if len(usage) != 2 {
		t.Errorf("len(usage) = %d, want 2", len(usage))
	}
	if len(warnings) != 0 {
		t.Errorf("len(warnings) = %d, want 0", len(warnings))
	}
}

func TestCollectUsageSkipsServerErrors(t *testing.T) {
	fetcher := &stubUsageFetcher{
		usage: map[int64]*github.WorkflowRunUsage{
			1: usageWithBillable(1000),
			3: usageWithBillable(3000),
		},
		errs: map[int64]error{2: statusError(http.StatusBadGateway)},
	}
	repo := repository.Repository{Owner: "o", Name: "r"}
	c := NewCollector(nil, repo, Options{Concurrency: 1}, nil)
	c.SetUsageFetcher(fetcher)

	usage, warnings, err := c.collectUsage(context.Background(), repo, []*github.WorkflowRun{runWithID(1), runWithID(2), runWithID(3)})
	if err != nil {
		t.Fatalf("collectUsage() error = %v", err)
	}
	if len(usage) != 2 {
		t.Errorf("len(usage) = %d, want 2", len(usage))
	}
	if len(warnings) != 1 {
		t.Fatalf("len(warnings) = %d, want 1", len(warnings))
	}
	if want := "skipped the usage of workflow run 2"; !strings.Contains(warnings[0], want) {
		t.Errorf("warnings[0] = %q, want it to contain %q", warnings[0], want)
	}
}

func TestCollectUsageFailsOnUnexpectedError(t *testing.T) {
	fetcher := &stubUsageFetcher{errs: map[int64]error{1: statusError(http.StatusUnauthorized)}}
	repo := repository.Repository{Owner: "o", Name: "r"}
	c := NewCollector(nil, repo, Options{Concurrency: 1}, nil)
	c.SetUsageFetcher(fetcher)

	if _, _, err := c.collectUsage(context.Background(), repo, []*github.WorkflowRun{runWithID(1)}); err == nil {
		t.Fatal("collectUsage() error = nil, want an error")
	}
}
