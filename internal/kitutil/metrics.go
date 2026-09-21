package kitutil

import (
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
)

// MetricsStepSummaryEnv names the file GitHub Actions renders on the run summary page.
const MetricsStepSummaryEnv = "GITHUB_STEP_SUMMARY"

// MetricsFlags carries the options shared by every metrics subcommand.
type MetricsFlags struct {
	Repo        string
	Owner       string
	Type        string
	Days        int
	Since       string
	MaxRuns     int
	Concurrency int
	Branch      string
	Event       string
	Workflow    string
	AllRepos    bool
	NoCache     bool
	Refresh     bool
	Exporter    cmdutil.Exporter
}

// AddOption configures which shared metrics flags Add registers.
type AddOption func(*addOptions)

type addOptions struct {
	cacheFlags bool
}

// WithoutCacheFlags omits the --no-cache/--refresh flags for commands that never read or
// write cached per-run metrics data, so the command does not advertise flags it ignores.
func WithoutCacheFlags() AddOption {
	return func(o *addOptions) { o.cacheFlags = false }
}

// Add registers the shared metrics flags on cmd.
func (m *MetricsFlags) Add(cmd *cobra.Command, opts ...AddOption) {
	options := addOptions{cacheFlags: true}
	for _, opt := range opts {
		opt(&options)
	}

	f := cmd.Flags()
	f.StringVarP(&m.Repo, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&m.Owner, "owner", "", "Select an organization by owner name")
	AddTypeFlag(cmd, &m.Type)
	f.IntVar(&m.Days, "days", metrics.DefaultDays, "Aggregate over the last N days")
	f.StringVar(&m.Since, "since", "", "Aggregate since this time, as YYYY-MM-DD or RFC3339 (cannot be used with --days)")
	f.IntVar(&m.MaxRuns, "max-runs", metrics.DefaultMaxRuns, "Stop after retrieving this many workflow runs per repository (0 for no limit)")
	f.IntVar(&m.Concurrency, "concurrency", metrics.DefaultConcurrency, "Number of per-run API requests to issue in parallel")
	f.StringVar(&m.Branch, "branch", "", "Keep only the workflow runs of this branch")
	f.StringVar(&m.Event, "event", "", "Keep only the workflow runs triggered by this event")
	f.StringVar(&m.Workflow, "workflow", "", "Keep only the runs of this workflow file, such as ci.yml")
	f.BoolVar(&m.AllRepos, "all-repos", false, "Collect the workflow runs of every repository in the organization")
	if options.cacheFlags {
		f.BoolVar(&m.NoCache, "no-cache", false, "Do not read or write cached per-run metrics data")
		f.BoolVar(&m.Refresh, "refresh", false, "Ignore cached per-run metrics data and fetch it again")
	}
	cmdutil.AddFormatFlags(cmd, &m.Exporter)

	cmd.MarkFlagsMutuallyExclusive("days", "since")
}

// Window resolves the aggregation window from the --days/--since flags. Commands that must
// validate the window before collecting data can call this first and hand the result to
// CollectWithWindow, so validation and collection agree on a single window.
func (m *MetricsFlags) Window() (metrics.Window, error) {
	return metrics.ParseWindow(m.Days, m.Since, time.Now())
}

// ResolveConcurrency parses the textual --bucket width, resolves the aggregation window and
// validates that their combination stays within the bucket-count limit, all without issuing
// any API request. Keeping this validation out of the command RunE and in a testable helper
// follows the repository convention that cobra commands only wire flags. It returns the
// resolved window and bucket width so the caller can collect data and build the timeline.
func (m *MetricsFlags) ResolveConcurrency(bucket string) (metrics.Window, time.Duration, error) {
	width, err := time.ParseDuration(bucket)
	if err != nil {
		return metrics.Window{}, 0, fmt.Errorf("failed to parse --bucket %q: %w", bucket, err)
	}
	if width <= 0 {
		return metrics.Window{}, 0, fmt.Errorf("--bucket must be greater than 0, got %s", bucket)
	}

	window, err := m.Window()
	if err != nil {
		return metrics.Window{}, 0, err
	}
	if err := metrics.ValidateBucketWindow(window, width); err != nil {
		return metrics.Window{}, 0, fmt.Errorf("invalid --bucket %s: %w", bucket, err)
	}
	return window, width, nil
}

// ResolveCapacity parses the textual --target-wait duration and validates it together with
// --target-utilization, without issuing any API request. It keeps the flag parsing and the
// non-library validation out of the command RunE, following the repository convention that
// cobra commands only wire flags, and returns the resolved target wait for the caller.
func (m *MetricsFlags) ResolveCapacity(targetWait string, targetUtilization float64) (time.Duration, error) {
	wait, err := time.ParseDuration(targetWait)
	if err != nil {
		return 0, fmt.Errorf("failed to parse --target-wait %q: %w", targetWait, err)
	}
	if err := metrics.ValidateCapacityTargets(wait, targetUtilization); err != nil {
		return 0, err
	}
	return wait, nil
}

// ResolveMetricsStepSummary returns the GitHub Actions step-summary path when the
// summary export is enabled.
func ResolveMetricsStepSummary(enabled bool) (string, error) {
	if !enabled {
		return "", nil
	}
	path := os.Getenv(MetricsStepSummaryEnv)
	if path == "" {
		return "", errors.New("--summary requires the " + MetricsStepSummaryEnv + " environment variable, which GitHub Actions sets")
	}
	return path, nil
}

// WarnMetricsWarnings emits the collection warnings to stderr without writing anything to
// stdout, so a machine-readable export stays clean while skipped repositories or runs are
// still surfaced the same way the other reports surface them.
func WarnMetricsWarnings(warnings []string) {
	for _, warning := range warnings {
		logger.Warn("metrics: " + warning)
	}
}

// Collect resolves the target scope and gathers the workflow activity the reports need.
func (m *MetricsFlags) Collect(cmd *cobra.Command) (*metrics.Data, error) {
	window, err := m.Window()
	if err != nil {
		return nil, err
	}
	return m.CollectWithWindow(cmd, window)
}

// CollectWithWindow collects metrics data for an already-resolved window.
func (m *MetricsFlags) CollectWithWindow(cmd *cobra.Command, window metrics.Window) (*metrics.Data, error) {
	return m.collect(cmd, window, collectFull)
}

// CollectUsage gathers the workflow runs together with the billable time GitHub charges
// for them. The per run job listing is skipped because the cost report works from the
// usage alone, which keeps the command at one request per run rather than two.
func (m *MetricsFlags) CollectUsage(cmd *cobra.Command) (*metrics.Data, error) {
	window, err := m.Window()
	if err != nil {
		return nil, err
	}
	return m.collect(cmd, window, collectUsage)
}

// CollectRuns gathers only the workflow runs, skipping the per run job listing. The run
// listing works from the runs alone, so this keeps the command at one request per run
// and avoids failing on a job-list error it does not need.
func (m *MetricsFlags) CollectRuns(cmd *cobra.Command) (*metrics.Data, error) {
	window, err := m.Window()
	if err != nil {
		return nil, err
	}
	return m.collect(cmd, window, collectRunsOnly)
}

// collectMode selects which per run data a collection fetches on top of the runs.
type collectMode int

const (
	// collectFull fetches the per run jobs the timeline and other reports need.
	collectFull collectMode = iota
	// collectUsage skips the jobs and fetches the billable usage instead.
	collectUsage
	// collectRunsOnly fetches neither, because the run listing needs only the runs.
	collectRunsOnly
)

func (m *MetricsFlags) collect(cmd *cobra.Command, window metrics.Window, mode collectMode) (*metrics.Data, error) {
	ctx := cmd.Context()

	repo, err := parser.Repository(
		parser.RepositoryOwnerWithHost(m.Owner),
		parser.RepositoryInput(m.Repo),
	)
	if err != nil {
		return nil, err
	}

	// The runner inventory follows --type, while the workflow runs always come from a
	// repository because the API offers no organization wide run listing.
	scope, err := ApplyRunnerType(cmd, repo, m.Type)
	if err != nil {
		return nil, err
	}

	var repos []repository.Repository
	if repo.Name != "" {
		repos = []repository.Repository{repo}
	}

	client, err := gh.NewGitHubClientWithRepo(scope)
	if err != nil {
		return nil, err
	}

	var jobs metrics.JobFetcher
	if mode == collectFull {
		jobs = m.jobFetcher(client)
	}

	collector := metrics.NewCollector(client, scope, metrics.Options{
		Repos:       repos,
		Window:      window,
		MaxRuns:     m.MaxRuns,
		Concurrency: m.Concurrency,
		Branch:      m.Branch,
		Event:       m.Event,
		Workflow:    m.Workflow,
		AllRepos:    m.AllRepos,
		SkipJobs:    mode != collectFull,
		SkipRunners: mode == collectRunsOnly,
	}, jobs)

	if mode == collectUsage {
		collector.SetUsageFetcher(m.usageFetcher(client))
	}

	return collector.Collect(ctx)
}

// jobFetcher wraps the API fetcher with the on-disk cache unless it is disabled or
// unavailable. The cache scopes each entry per repository, so a single instance is
// safe to share across a repository collection.
func (m *MetricsFlags) jobFetcher(client *gh.GitHubClient) metrics.JobFetcher {
	fetcher := metrics.JobFetcher(metrics.NewAPIJobFetcher(client))
	if cache, ok := m.cache(); ok {
		return metrics.NewCachedJobFetcher(fetcher, cache, m.Refresh)
	}
	return fetcher
}

// usageFetcher wraps the API fetcher with the on-disk cache, like jobFetcher does.
func (m *MetricsFlags) usageFetcher(client *gh.GitHubClient) metrics.UsageFetcher {
	fetcher := metrics.UsageFetcher(metrics.NewAPIUsageFetcher(client))
	if cache, ok := m.cache(); ok {
		return metrics.NewCachedUsageFetcher(fetcher, cache, m.Refresh)
	}
	return fetcher
}

// cache opens the on-disk cache, reporting false when it is disabled or unusable.
func (m *MetricsFlags) cache() (*metrics.Cache, bool) {
	if m.NoCache {
		return nil, false
	}

	cache, err := metrics.NewCache()
	if err != nil {
		logger.Warn("metrics: continuing without the local cache", "error", err)
		return nil, false
	}
	return cache, true
}
