package metrics

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v93/github"
	ghclient "github.com/srz-zumix/go-gh-extension/pkg/gh/client"
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
	for _, cause := range []error{statusError(http.StatusUnauthorized), io.ErrUnexpectedEOF} {
		t.Run(cause.Error(), func(t *testing.T) {
			fetcher := &stubJobFetcher{errs: map[int64]error{1: cause}}
			repo := repository.Repository{Owner: "o", Name: "r"}
			c := NewCollector(nil, repo, Options{Concurrency: 1}, fetcher)

			jobs, warnings, err := c.collectJobs(context.Background(), repo, []*github.WorkflowRun{runWithID(1)})
			if !errors.Is(err, cause) || !strings.Contains(err.Error(), "workflow run 1") {
				t.Fatalf("collectJobs() error = %v, want run context wrapping %v", err, cause)
			}
			if len(jobs) != 0 || len(warnings) != 0 {
				t.Fatalf("failed collection returned partial data: jobs=%v warnings=%v", jobs, warnings)
			}
		})
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

// TestWithRetryFailsFastWhenResetIsOutOfReach makes sure an exhausted primary limit whose
// reset lies beyond every retry left fails at once instead of sleeping through retries
// that cannot succeed.
func TestWithRetryFailsFastWhenResetIsOutOfReach(t *testing.T) {
	rateErr := &github.RateLimitError{
		Rate:     github.Rate{Reset: github.Timestamp{Time: time.Now().Add(time.Hour)}},
		Response: &http.Response{StatusCode: http.StatusForbidden},
	}
	calls := 0
	started := time.Now()
	err := withRetry(context.Background(), func() error {
		calls++
		return rateErr
	})
	if !errors.Is(err, rateErr) {
		t.Fatalf("withRetry() error = %v, want the rate limit error", err)
	}
	if calls != 1 {
		t.Fatalf("withRetry() called fn %d times, want 1", calls)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("withRetry() took %v, want an immediate failure", elapsed)
	}
}

// TestWithRetryReturnsOtherErrorsImmediately confirms non-retryable errors fail fast.
func TestWithRetryReturnsOtherErrorsImmediately(t *testing.T) {
	want := errors.New("boom")
	calls := 0
	err := withRetry(context.Background(), func() error {
		calls++
		return want
	})
	if !errors.Is(err, want) || calls != 1 {
		t.Fatalf("withRetry() = %v after %d calls, want %v after 1", err, calls, want)
	}
}

func TestWithRetryEOF(t *testing.T) {
	for _, cause := range []error{io.EOF, io.ErrUnexpectedEOF} {
		for _, recover := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/recover=%t", cause, recover), func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					started := time.Now()
					calls := 0
					wrapped := fmt.Errorf("read jobs: %w", cause)
					err := withRetry(context.Background(), func() error {
						calls++
						if recover && calls == 2 {
							return nil
						}
						return wrapped
					})
					if recover {
						if err != nil || calls != 2 || time.Since(started) != time.Second {
							t.Fatalf("recovery: error=%v calls=%d elapsed=%v", err, calls, time.Since(started))
						}
					} else if !errors.Is(err, cause) || calls != 5 || time.Since(started) != 15*time.Second {
						t.Fatalf("exhaustion: error=%v calls=%d elapsed=%v", err, calls, time.Since(started))
					}
				})
			})
		}
	}
}

func TestWithRetryCancellation(t *testing.T) {
	for _, duringWait := range []bool{false, true} {
		t.Run(fmt.Sprintf("duringWait=%t", duringWait), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				if duringWait {
					go func() {
						time.Sleep(500 * time.Millisecond)
						cancel()
					}()
				} else {
					cancel()
				}
				calls := 0
				err := withRetry(ctx, func() error {
					calls++
					return io.ErrUnexpectedEOF
				})
				wantCalls := 0
				if duringWait {
					wantCalls = 1
				}
				if !errors.Is(err, context.Canceled) || calls != wantCalls {
					t.Fatalf("cancellation: error=%v calls=%d, want %d calls", err, calls, wantCalls)
				}
			})
		})
	}
}

func TestWithRetryRateLimitDelays(t *testing.T) {
	for _, primary := range []bool{true, false} {
		t.Run(fmt.Sprintf("primary=%t", primary), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				delay := 3 * time.Second
				var cause error = &github.AbuseRateLimitError{RetryAfter: &delay}
				if primary {
					cause = &github.RateLimitError{Rate: github.Rate{Reset: github.Timestamp{Time: time.Now().Add(delay)}}}
				}
				started := time.Now()
				calls := 0
				err := withRetry(context.Background(), func() error {
					calls++
					if calls == 1 {
						return fmt.Errorf("API: %w", cause)
					}
					return nil
				})
				if err != nil || calls != 2 || time.Since(started) != delay {
					t.Fatalf("rate limit: error=%v calls=%d elapsed=%v", err, calls, time.Since(started))
				}
			})
		})
	}
}

type retryJobTransport func(*http.Request) (*http.Response, error)

func (f retryJobTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}

type interruptedJobBody struct {
	io.ReadCloser
}

func (b interruptedJobBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if err == io.EOF {
		err = io.ErrUnexpectedEOF
	}
	return n, err
}

func TestAPIJobFetchersRetryTruncatedPagination(t *testing.T) {
	for _, historical := range []bool{false, true} {
		t.Run(fmt.Sprintf("historical=%t", historical), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				jobPath := "/repos/o/r/actions/runs/42/jobs"
				if historical {
					jobPath = "/repos/o/r/actions/runs/42/attempts/2/jobs"
				}
				base := "http://example.test/"
				fail := true
				firstPages, secondPages := 0, 0
				transport := retryJobTransport(func(r *http.Request) (*http.Response, error) {
					if r.URL.Path != jobPath {
						t.Fatalf("unexpected request: %s", r.URL)
					}
					header := make(http.Header)
					header.Set("Content-Type", "application/json")
					payload := `{"total_count":2,"jobs":[{"id":11}]}`
					interrupted := false
					if r.URL.Query().Get("page") == "2" {
						secondPages++
						payload = `{"total_count":2,"jobs":[{"id":22}]}`
						if fail || secondPages == 6 {
							payload = `{"total_count":2,"jobs":[{"id":`
							interrupted = true
						}
					} else {
						firstPages++
						header.Set("Link", fmt.Sprintf(`<%s%s?page=2>; rel="next"`, strings.TrimSuffix(base, "/"), jobPath))
					}
					body := io.NopCloser(strings.NewReader(payload))
					if interrupted {
						body = interruptedJobBody{body}
					}
					return &http.Response{
						StatusCode: http.StatusOK, Header: header,
						Body: body, Request: r,
					}, nil
				})
				api, err := github.NewClient(github.WithHTTPClient(&http.Client{Transport: transport}), github.WithURLs(&base, nil))
				if err != nil {
					t.Fatal(err)
				}
				client, err := ghclient.NewClient(api)
				if err != nil {
					t.Fatal(err)
				}
				cache := &Cache{base: t.TempDir()}
				fetcher := NewCachedJobFetcher(NewAPIJobFetcher(client), cache, false)
				if historical {
					fetcher = NewCachedAttemptJobFetcher(NewAPIAttemptJobFetcher(client), cache, false)
				}
				repo := repository.Repository{Owner: "o", Name: "r"}
				run := &github.WorkflowRun{ID: github.Ptr(int64(42)), RunAttempt: github.Ptr(2), Status: github.Ptr("completed")}
				jobs, cached, err := fetcher.JobsWithCache(context.Background(), repo, run)
				if !errors.Is(err, io.ErrUnexpectedEOF) || cached || len(jobs) != 0 || firstPages != 5 || secondPages != 5 {
					t.Fatalf("failed listing: jobs=%v cached=%t error=%v pages=%d/%d", jobs, cached, err, firstPages, secondPages)
				}
				if _, ok := fetcher.load(repo, 42, 2); ok {
					t.Fatal("incomplete job list was cached")
				}
				fail = false
				for _, wantCached := range []bool{false, true} {
					jobs, cached, err = fetcher.JobsWithCache(context.Background(), repo, run)
					if err != nil || cached != wantCached || len(jobs) != 2 || jobs[0].GetID() != 11 || jobs[1].GetID() != 22 {
						t.Fatalf("recovered listing: jobs=%v cached=%t error=%v", jobs, cached, err)
					}
					if firstPages != 7 || secondPages != 7 {
						t.Fatalf("unexpected page requests: first=%d second=%d", firstPages, secondPages)
					}
				}
			})
		})
	}
}

// TestResetsAfter covers which errors count as a primary limit resetting out of reach.
func TestResetsAfter(t *testing.T) {
	soon := &github.RateLimitError{Rate: github.Rate{Reset: github.Timestamp{Time: time.Now().Add(time.Minute)}}}
	late := &github.RateLimitError{Rate: github.Rate{Reset: github.Timestamp{Time: time.Now().Add(time.Hour)}}}
	secondary := &github.AbuseRateLimitError{}

	if resetsAfter(soon, 8*time.Minute) {
		t.Error("resetsAfter(soon) = true, want false")
	}
	if !resetsAfter(late, 8*time.Minute) {
		t.Error("resetsAfter(late) = false, want true")
	}
	if resetsAfter(secondary, 0) {
		t.Error("resetsAfter(secondary) = true, want false")
	}
}
