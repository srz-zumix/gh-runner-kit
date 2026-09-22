package metrics

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"path"
	"sync"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
	"golang.org/x/sync/errgroup"
)

const (
	// DefaultDays is the aggregation window used when neither --days nor --since is given.
	DefaultDays = 7
	// DefaultMaxRuns caps how many workflow runs a single command retrieves per repository.
	DefaultMaxRuns = 300
	// DefaultConcurrency is the number of per-run API requests issued in parallel.
	DefaultConcurrency = 6

	// maxRetries is how often a rate limited request is retried before giving up.
	maxRetries = 5
	// maxRetryWait bounds how long a single retry may wait for a rate limit to reset.
	maxRetryWait = 2 * time.Minute
)

// Options controls the scope and the API cost of a collection run.
type Options struct {
	// Repos are the repositories whose workflow runs are collected. It is ignored when
	// AllRepos is set.
	Repos  []repository.Repository
	Window Window
	// MaxRuns caps the runs retrieved from each repository. The budget is per repository
	// so that a busy one cannot leave the repositories collected after it unvisited.
	MaxRuns     int
	Concurrency int
	Branch      string
	Event       string
	// Workflow is a workflow file name such as ci.yml. Empty collects every workflow.
	Workflow string
	// AllRepos collects the runs of every repository owned by the organization instead
	// of only the repositories listed in Repos.
	AllRepos bool
	// IncludeRepos is a list of repository pattern strings such as "octo/*" or
	// "OWNER/REPO". A repository that matches none of the patterns is skipped before
	// any workflow run request is sent.
	IncludeRepos []string
	// ExcludeRepos drops repositories that match any of these patterns.
	ExcludeRepos []string
	// SkipJobs leaves the per run job listing out of the collection. Reports that work
	// from the runs alone save one API request per run with it.
	SkipJobs bool
	// SkipRunners leaves the runner inventory out of the collection. Reports that work
	// from the runs alone skip the request and cannot be aborted by a runner API error
	// they do not need.
	SkipRunners bool
}

// Data holds everything a Collector gathered, together with what it could not gather.
type Data struct {
	Window Window
	// Runners is the runner inventory of the scope the command targets. It reflects the
	// present, not the aggregation window, because the API keeps no runner history.
	Runners []*github.Runner
	Runs    []*github.WorkflowRun
	Jobs    []*github.WorkflowJob
	// Repos reports what the collection read of every repository it could read, which is
	// how a quiet repository is told apart from one the run limit cut short.
	Repos []RepoCoverage
	// RunRepositories maps a workflow run ID to the full name (owner/repo) of the
	// repository it belongs to. The raw jobs do not carry their repository, so this is
	// how per-workflow aggregation keeps runs of equally named workflows in distinct
	// repositories apart, which matters most under --all-repos.
	RunRepositories map[int64]string
	// Usage holds the billable time of every collected run, keyed by run ID. Only the
	// commands that ask for it populate this, because it costs one request per run.
	Usage    map[int64]*github.WorkflowRunUsage
	Warnings []string
	// Truncated reports whether the run limit cut at least one repository short. Repos
	// names which ones.
	Truncated bool
}

// RepoCoverage records how much of a repository a collection managed to read.
type RepoCoverage struct {
	Repository repository.Repository
	Runs       int
	Truncated  bool
}

// FullName renders the repository as owner/repo.
func (c RepoCoverage) FullName() string {
	return parser.GetRepositoryFullName(c.Repository)
}

// TruncatedRepos counts the repositories the run limit cut short.
func (d *Data) TruncatedRepos() int {
	n := 0
	for _, repo := range d.Repos {
		if repo.Truncated {
			n++
		}
	}
	return n
}

// SelfHostedRunnerIDs indexes the currently registered runners by ID, which is the
// signal ClassifyJob trusts most.
func (d *Data) SelfHostedRunnerIDs() map[int64]bool {
	ids := make(map[int64]bool, len(d.Runners))
	for _, runner := range d.Runners {
		ids[runner.GetID()] = true
	}
	return ids
}

// JobFetcher retrieves the jobs of a single workflow run.
type JobFetcher interface {
	Jobs(ctx context.Context, repo repository.Repository, run *github.WorkflowRun) ([]*github.WorkflowJob, error)
}

// APIJobFetcher reads job lists straight from the GitHub API.
type APIJobFetcher struct {
	client *gh.GitHubClient
}

// NewAPIJobFetcher builds a JobFetcher backed by client.
func NewAPIJobFetcher(client *gh.GitHubClient) *APIJobFetcher {
	return &APIJobFetcher{client: client}
}

// Jobs implements JobFetcher.
func (f *APIJobFetcher) Jobs(ctx context.Context, repo repository.Repository, run *github.WorkflowRun) ([]*github.WorkflowJob, error) {
	var jobs []*github.WorkflowJob
	err := withRetry(ctx, func() error {
		var err error
		jobs, err = gh.ListWorkflowJobs(ctx, f.client, repo, run.GetID(), nil)
		return err
	})
	return jobs, err
}

// CachedJobFetcher serves job lists from disk before falling back to inner.
// Only completed runs are cached, because the job list of a run still in progress keeps
// changing and would otherwise be frozen at its first observation.
type CachedJobFetcher struct {
	inner   JobFetcher
	cache   *Cache
	refresh bool
}

// NewCachedJobFetcher wraps inner with cache. refresh ignores existing entries and
// rewrites them from the API.
func NewCachedJobFetcher(inner JobFetcher, cache *Cache, refresh bool) *CachedJobFetcher {
	return &CachedJobFetcher{inner: inner, cache: cache, refresh: refresh}
}

// Jobs implements JobFetcher.
func (f *CachedJobFetcher) Jobs(ctx context.Context, repo repository.Repository, run *github.WorkflowRun) ([]*github.WorkflowJob, error) {
	cacheable := run.GetStatus() == "completed"
	runID := run.GetID()

	if cacheable && !f.refresh {
		if jobs, ok := f.cache.LoadJobs(repo, runID); ok {
			logger.Debug("metrics: job cache hit", "run_id", runID)
			return jobs, nil
		}
	}

	jobs, err := f.inner.Jobs(ctx, repo, run)
	if err != nil {
		return nil, err
	}

	if cacheable {
		if err := f.cache.SaveJobs(repo, runID, jobs); err != nil {
			logger.Debug("metrics: failed to cache jobs", "run_id", runID, "error", err)
		}
	}
	return jobs, nil
}

// Collector gathers the workflow runs, jobs and runners a metrics command needs.
type Collector struct {
	client *gh.GitHubClient
	repo   repository.Repository
	opts   Options
	jobs   JobFetcher
	usage  UsageFetcher
}

// NewCollector builds a Collector for repo. When repo.Name is empty the runner
// inventory is read at the organization level. jobs may be nil when opts.SkipJobs is
// true, because that collection mode never requests job details.
func NewCollector(client *gh.GitHubClient, repo repository.Repository, opts Options, jobs JobFetcher) *Collector {
	if opts.Concurrency <= 0 {
		opts.Concurrency = DefaultConcurrency
	}
	return &Collector{client: client, repo: repo, opts: opts, jobs: jobs}
}

// SetUsageFetcher makes Collect also retrieve the billable usage of every run, which
// costs one extra API request per run. Only the cost report needs it.
func (c *Collector) SetUsageFetcher(usage UsageFetcher) {
	c.usage = usage
}

// Collect gathers the runner inventory and the workflow activity of the window.
// Repositories the token cannot read are recorded in Data.Warnings and skipped rather
// than aborting the whole command.
func (c *Collector) Collect(ctx context.Context) (*Data, error) {
	if err := c.opts.ValidateRepositoryPatterns(); err != nil {
		return nil, err
	}

	data := &Data{
		Window:          c.opts.Window,
		RunRepositories: map[int64]string{},
		Usage:           map[int64]*github.WorkflowRunUsage{},
	}

	if !c.opts.SkipRunners {
		runners, err := gh.ListRunners(ctx, c.client, c.repo)
		switch {
		case err == nil:
			data.Runners = runners
		case gh.IsHTTPForbidden(err), gh.IsHTTPNotFound(err):
			data.warnf("skipped the runner inventory of %s: %v", parser.GetRepositoryFullName(c.repo), err)
		default:
			return nil, fmt.Errorf("failed to list the runners of %s: %w", parser.GetRepositoryFullName(c.repo), err)
		}
	}

	repos, err := c.targetRepositories(ctx)
	if err != nil {
		return nil, err
	}

	for _, repo := range repos {
		runs, truncated, err := c.collectRuns(ctx, repo, c.opts.MaxRuns)
		if err != nil {
			if gh.IsHTTPForbidden(err) || gh.IsHTTPNotFound(err) {
				data.warnf("skipped the workflow runs of %s: %v", parser.GetRepositoryFullName(repo), err)
				continue
			}
			return nil, fmt.Errorf("failed to list the workflow runs of %s: %w", parser.GetRepositoryFullName(repo), err)
		}
		// Only repositories whose runs were read successfully count as collected, so the
		// repository total never includes the ones skipped above.
		data.Repos = append(data.Repos, RepoCoverage{Repository: repo, Runs: len(runs), Truncated: truncated})
		data.Truncated = data.Truncated || truncated
		data.Runs = append(data.Runs, runs...)

		// Record which repository every run came from so per-workflow aggregation can
		// tell equally named workflows of different repositories apart.
		repoName := parser.GetRepositoryFullName(repo)
		for _, run := range runs {
			data.RunRepositories[run.GetID()] = repoName
		}

		if !c.opts.SkipJobs {
			jobs, warnings, err := c.collectJobs(ctx, repo, runs)
			if err != nil {
				return nil, fmt.Errorf("failed to list the workflow jobs of %s: %w", parser.GetRepositoryFullName(repo), err)
			}
			data.Jobs = append(data.Jobs, jobs...)
			data.Warnings = append(data.Warnings, warnings...)
		}

		if c.usage != nil {
			usage, warnings, err := c.collectUsage(ctx, repo, runs)
			if err != nil {
				return nil, fmt.Errorf("failed to read the usage of the workflow runs of %s: %w", parser.GetRepositoryFullName(repo), err)
			}
			maps.Copy(data.Usage, usage)
			data.Warnings = append(data.Warnings, warnings...)
		}
	}

	return data, nil
}

// targetRepositories resolves which repositories the runs are collected from.
func (c *Collector) targetRepositories(ctx context.Context) ([]repository.Repository, error) {
	if !c.opts.AllRepos {
		if len(c.opts.Repos) == 0 {
			return nil, errors.New("collecting workflow runs requires a repository: pass --repo or --all-repos")
		}
		return filterRepositories(c.opts.Repos, c.opts.IncludeRepos, c.opts.ExcludeRepos)
	}

	owned, err := gh.ListOwnerRepositories(ctx, c.client, c.repo)
	if err != nil {
		return nil, fmt.Errorf("failed to list the repositories of %s: %w", c.repo.Owner, err)
	}

	repos := make([]repository.Repository, 0, len(owned))
	for _, r := range owned {
		if r.GetArchived() {
			continue
		}
		repos = append(repos, repository.Repository{Host: c.repo.Host, Owner: c.repo.Owner, Name: r.GetName()})
	}

	repos, err = filterRepositories(repos, c.opts.IncludeRepos, c.opts.ExcludeRepos)
	if err != nil {
		return nil, err
	}

	logger.Warn("metrics: collecting workflow runs across repositories, this issues many API requests", "repositories", len(repos), "max_runs_per_repository", c.opts.MaxRuns)
	return repos, nil
}

func filterRepositories(repos []repository.Repository, include, exclude []string) ([]repository.Repository, error) {
	filtered := make([]repository.Repository, 0, len(repos))
	for _, repo := range repos {
		if len(include) > 0 && !matchesRepositoryPatternSet(include, repo) {
			continue
		}
		if matchesRepositoryPatternSet(exclude, repo) {
			continue
		}
		filtered = append(filtered, repo)
	}
	if len(include) > 0 && len(filtered) == 0 {
		return nil, fmt.Errorf("no repositories matched include filter %v", include)
	}
	return filtered, nil
}

// ValidateRepositoryPatterns rejects the include/exclude patterns path.Match cannot
// parse, so a malformed --include-repo or --exclude-repo is reported before any API
// request rather than silently matching nothing.
func (o Options) ValidateRepositoryPatterns() error {
	if err := validateRepositoryPatterns("--include-repo", o.IncludeRepos); err != nil {
		return err
	}
	return validateRepositoryPatterns("--exclude-repo", o.ExcludeRepos)
}

// validateRepositoryPatterns reports the first pattern path.Match cannot parse, naming
// the flag it came from.
func validateRepositoryPatterns(flag string, patterns []string) error {
	for _, pattern := range patterns {
		if _, err := path.Match(pattern, ""); err != nil {
			return fmt.Errorf("invalid %s pattern %q: %w", flag, pattern, err)
		}
	}
	return nil
}

func matchesRepositoryPatternSet(patterns []string, repo repository.Repository) bool {
	for _, pattern := range patterns {
		if pattern == "" {
			continue
		}
		if matchesRepositoryPattern(pattern, repo) {
			return true
		}
	}
	return false
}

func matchesRepositoryPattern(pattern string, repo repository.Repository) bool {
	name := repo.Owner + "/" + repo.Name
	fullName := parser.GetRepositoryFullName(repo)
	if pattern == name || pattern == fullName {
		return true
	}
	if repo.Host != "" {
		fullHost := repo.Host + "/" + name
		if pattern == fullHost {
			return true
		}
		if ok, err := path.Match(pattern, fullHost); err == nil && ok {
			return true
		}
	}
	if ok, err := path.Match(pattern, name); err == nil && ok {
		return true
	}
	return false
}

// collectRuns lists the workflow runs of repo that started inside the window, reporting
// whether limit stopped the listing before the window did.
func (c *Collector) collectRuns(ctx context.Context, repo repository.Repository, limit int) ([]*github.WorkflowRun, bool, error) {
	options := &gh.ListWorkflowRunsOptions{
		Branch:  c.opts.Branch,
		Event:   c.opts.Event,
		Created: c.opts.Window.Created(),
		Limit:   limit,
	}

	var runs []*github.WorkflowRun
	err := withRetry(ctx, func() error {
		var err error
		if c.opts.Workflow != "" {
			runs, err = gh.ListWorkflowRunsByFileName(ctx, c.client, repo, c.opts.Workflow, options)
		} else {
			runs, err = gh.ListRepositoryWorkflowRuns(ctx, c.client, repo, options)
		}
		return err
	})
	if err != nil {
		return nil, false, err
	}

	filtered, truncated := selectWindowRuns(c.opts.Window, runs, limit)
	return filtered, truncated, nil
}

// selectWindowRuns drops the runs outside w and reports whether limit was spent. The
// limit applies before the window filter, so the kept count alone cannot show it.
func selectWindowRuns(w Window, runs []*github.WorkflowRun, limit int) ([]*github.WorkflowRun, bool) {
	// The created filter has day granularity, so drop the runs that fall outside the
	// exact window.
	filtered := make([]*github.WorkflowRun, 0, len(runs))
	for _, run := range runs {
		if w.Contains(run.GetCreatedAt().Time) {
			filtered = append(filtered, run)
		}
	}
	return filtered, limit > 0 && len(runs) >= limit
}

// collectJobs fetches the jobs of every run in parallel, bounded by --concurrency.
func (c *Collector) collectJobs(ctx context.Context, repo repository.Repository, runs []*github.WorkflowRun) ([]*github.WorkflowJob, []string, error) {
	var (
		mu       sync.Mutex
		jobs     []*github.WorkflowJob
		warnings []string
	)

	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(c.opts.Concurrency)

	for _, run := range runs {
		g.Go(func() error {
			runJobs, err := c.jobs.Jobs(ctx, repo, run)
			if err != nil {
				if !isSkippableRunRequestError(err) {
					return err
				}
				mu.Lock()
				warnings = append(warnings, fmt.Sprintf("skipped the jobs of workflow run %d: %v", run.GetID(), err))
				mu.Unlock()
				return nil
			}

			mu.Lock()
			jobs = append(jobs, runJobs...)
			mu.Unlock()
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, nil, err
	}
	return jobs, warnings, nil
}

// collectUsage fetches the billable usage of every run in parallel, bounded by
// --concurrency. A run whose usage cannot be read is reported as a warning, exactly as
// an unreadable job list is, so one run never costs the whole report.
func (c *Collector) collectUsage(ctx context.Context, repo repository.Repository, runs []*github.WorkflowRun) (map[int64]*github.WorkflowRunUsage, []string, error) {
	var (
		mu       sync.Mutex
		usage    = make(map[int64]*github.WorkflowRunUsage, len(runs))
		warnings []string
	)

	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(c.opts.Concurrency)

	for _, run := range runs {
		g.Go(func() error {
			runUsage, err := c.usage.Usage(ctx, repo, run)
			if err != nil {
				if !isSkippableRunRequestError(err) {
					return err
				}
				mu.Lock()
				warnings = append(warnings, fmt.Sprintf("skipped the usage of workflow run %d: %v", run.GetID(), err))
				mu.Unlock()
				return nil
			}

			mu.Lock()
			usage[run.GetID()] = runUsage
			mu.Unlock()
			return nil
		})
	}

	if err := g.Wait(); err != nil {
		return nil, nil, err
	}
	return usage, warnings, nil
}

// isSkippableRunRequestError reports whether a failed per run request may be downgraded
// to a warning. Besides the repositories the token cannot read, GitHub answers with 5xx
// for individual runs of large repositories, and one such run must not lose the whole
// report.
func isSkippableRunRequestError(err error) bool {
	if gh.IsHTTPForbidden(err) || gh.IsHTTPNotFound(err) {
		return true
	}

	var errResp *github.ErrorResponse
	return errors.As(err, &errResp) && errResp.Response != nil && errResp.Response.StatusCode >= 500
}

// warnf records a non fatal problem so that commands can tell the user their numbers
// are based on incomplete data.
func (d *Data) warnf(format string, args ...any) {
	d.Warnings = append(d.Warnings, fmt.Sprintf(format, args...))
}

// withRetry retries fn while GitHub reports a rate limit, backing off until the limit
// resets. Every other error is returned immediately.
func withRetry(ctx context.Context, fn func() error) error {
	var err error
	for attempt := range maxRetries {
		if err = fn(); err == nil {
			return nil
		}

		wait, ok := retryWait(err)
		if !ok {
			return err
		}

		logger.Debug("metrics: rate limited, waiting before retrying", "attempt", attempt+1, "wait", wait)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
	return err
}

// retryWait returns how long to wait before retrying err, reporting false when err is
// not a rate limit error.
func retryWait(err error) (time.Duration, bool) {
	var rateErr *github.RateLimitError
	if errors.As(err, &rateErr) {
		return clampRetryWait(time.Until(rateErr.Rate.Reset.Time)), true
	}

	var abuseErr *github.AbuseRateLimitError
	if errors.As(err, &abuseErr) {
		if abuseErr.RetryAfter != nil {
			return clampRetryWait(*abuseErr.RetryAfter), true
		}
		return time.Second, true
	}

	return 0, false
}

func clampRetryWait(d time.Duration) time.Duration {
	if d < time.Second {
		return time.Second
	}
	return min(d, maxRetryWait)
}
