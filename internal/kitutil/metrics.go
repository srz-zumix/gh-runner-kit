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
	Repo         string
	Owner        string
	Type         string
	Days         int
	Since        string
	MaxRuns      int
	Concurrency  int
	Branch       string
	Event        string
	Workflow     string
	AllRepos     bool
	IncludeRepos []string
	ExcludeRepos []string
	NoCache      bool
	Refresh      bool
	Input        string
	Exporter     cmdutil.Exporter

	// snapshot memoizes the --input file across the Window and collect calls of a
	// single command run, so it is decoded from disk only once.
	snapshot *metrics.Snapshot
}

// AddOption configures which shared metrics flags Add registers.
type AddOption func(*addOptions)

type addOptions struct {
	cacheFlags  bool
	inputFlag   bool
	formatFlags bool
}

// WithoutCacheFlags omits the --no-cache/--refresh flags for commands that never read or
// write cached per-run metrics data, so the command does not advertise flags it ignores.
func WithoutCacheFlags() AddOption {
	return func(o *addOptions) { o.cacheFlags = false }
}

// WithoutInputFlag omits the --input flag for `metrics collect`, the one command that
// always collects from the API rather than ever reading a snapshot back.
func WithoutInputFlag() AddOption {
	return func(o *addOptions) { o.inputFlag = false }
}

// WithoutFormatFlags omits --format/--jq/--template for `metrics collect`, which writes
// a snapshot rather than rendering a report.
func WithoutFormatFlags() AddOption {
	return func(o *addOptions) { o.formatFlags = false }
}

// collectionFlagNames lists every flag that only affects an API collection, so a
// command that reads --input instead can reject each of them individually without
// also forbidding combinations, such as --repo together with --owner, that stay legal
// when collecting from the API.
var collectionFlagNames = []string{
	"repo", "owner", "type", "days", "since", "max-runs", "concurrency",
	"branch", "event", "workflow", "all-repos", "include-repo", "exclude-repo",
}

// Add registers the shared metrics flags on cmd.
func (m *MetricsFlags) Add(cmd *cobra.Command, opts ...AddOption) {
	options := addOptions{cacheFlags: true, inputFlag: true, formatFlags: true}
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
	f.StringArrayVar(&m.IncludeRepos, "include-repo", nil, "Keep only the repositories matching this pattern, such as octo/*, owner/repo or [HOST/]OWNER/REPO (repeatable)")
	f.StringArrayVar(&m.ExcludeRepos, "exclude-repo", nil, "Drop the repositories matching this pattern, such as octo/* or [HOST/]OWNER/REPO (repeatable)")
	if options.cacheFlags {
		f.BoolVar(&m.NoCache, "no-cache", false, "Do not read or write cached per-run metrics data")
		f.BoolVar(&m.Refresh, "refresh", false, "Ignore cached per-run metrics data and fetch it again")
	}
	if options.inputFlag {
		f.StringVar(&m.Input, "input", "", "Read a snapshot metrics collect wrote instead of collecting from the API (- for stdin)")
	}
	if options.formatFlags {
		cmdutil.AddFormatFlags(cmd, &m.Exporter)
	}

	cmd.MarkFlagsMutuallyExclusive("days", "since")
	if options.inputFlag {
		exclusive := collectionFlagNames
		if options.cacheFlags {
			exclusive = append(append([]string{}, collectionFlagNames...), "no-cache", "refresh")
		}
		for _, name := range exclusive {
			cmd.MarkFlagsMutuallyExclusive("input", name)
		}
	}
}

// Window resolves the aggregation window from the --days/--since flags. Commands that must
// validate the window before collecting data can call this first and hand the result to
// CollectWithWindow, so validation and collection agree on a single window.
// When --input is set, the window comes from the snapshot instead, so a report run
// against it always describes the window the snapshot was actually collected over.
func (m *MetricsFlags) Window() (metrics.Window, error) {
	if m.Input != "" {
		snap, err := m.loadSnapshot()
		if err != nil {
			return metrics.Window{}, err
		}
		return snap.Data.Window, nil
	}
	return metrics.ParseWindow(m.Days, m.Since, time.Now())
}

// loadSnapshot decodes --input once and reuses it for every later call in the same
// command run, so Window and collect never read the file twice.
func (m *MetricsFlags) loadSnapshot() (*metrics.Snapshot, error) {
	if m.snapshot == nil {
		snap, err := metrics.ReadSnapshot(m.Input)
		if err != nil {
			return nil, err
		}
		m.snapshot = snap
	}
	return m.snapshot, nil
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

// CollectReport gathers what `metrics report` needs: the runner inventory, the
// workflow runs and their jobs, plus the billable usage of every run when withUsage
// is set, because only its cost section needs it. --input is honoured like the other
// Collect* methods, requiring the snapshot to carry usage too when withUsage is set.
func (m *MetricsFlags) CollectReport(cmd *cobra.Command, withUsage bool) (*metrics.Data, error) {
	if m.Input != "" {
		snap, err := m.loadSnapshot()
		if err != nil {
			return nil, err
		}
		if err := snap.Require(true, withUsage); err != nil {
			return nil, err
		}
		return snap.Data, nil
	}

	window, err := m.Window()
	if err != nil {
		return nil, err
	}
	collector, _, err := m.buildCollector(cmd, window, false, false, withUsage)
	if err != nil {
		return nil, err
	}
	return collector.Collect(cmd.Context())
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
	if m.Input != "" {
		snap, err := m.loadSnapshot()
		if err != nil {
			return nil, err
		}
		if err := snap.Require(mode == collectFull, mode == collectUsage); err != nil {
			return nil, err
		}
		return snap.Data, nil
	}

	collector, _, err := m.buildCollector(cmd, window, mode != collectFull, mode == collectRunsOnly, mode == collectUsage)
	if err != nil {
		return nil, err
	}
	return collector.Collect(cmd.Context())
}

// CollectSnapshot gathers the runner inventory, the workflow runs and their jobs, plus
// the billable usage of every run when withUsage is set, and packages the result as a
// Snapshot ready for WriteSnapshot. Unlike collect it never reads --input, because
// `metrics collect` is what produces the file --input reads back.
func (m *MetricsFlags) CollectSnapshot(cmd *cobra.Command, withUsage bool) (*metrics.Snapshot, error) {
	window, err := m.Window()
	if err != nil {
		return nil, err
	}

	collector, scope, err := m.buildCollector(cmd, window, false, false, withUsage)
	if err != nil {
		return nil, err
	}
	data, err := collector.Collect(cmd.Context())
	if err != nil {
		return nil, err
	}

	return &metrics.Snapshot{
		Version:   metrics.CurrentSnapshotVersion,
		CreatedAt: time.Now().UTC(),
		Repo:      scope,
		Contents:  metrics.SnapshotContents{Jobs: true, Usage: withUsage, Runners: true},
		Data:      data,
	}, nil
}

// buildCollector resolves the target scope and assembles the Collector that fetches
// it, leaving the API request to the caller. skipJobs and skipRunners mirror the
// Options fields of the same name; wantUsage additionally attaches a usage fetcher.
func (m *MetricsFlags) buildCollector(cmd *cobra.Command, window metrics.Window, skipJobs, skipRunners, wantUsage bool) (*metrics.Collector, repository.Repository, error) {
	repo, err := parser.Repository(
		parser.RepositoryOwnerWithHost(m.Owner),
		parser.RepositoryInput(m.Repo),
	)
	if err != nil {
		return nil, repository.Repository{}, err
	}

	// The runner inventory follows --type, while the workflow runs always come from a
	// repository because the API offers no organization wide run listing.
	scope, err := ApplyRunnerType(cmd, repo, m.Type)
	if err != nil {
		return nil, repository.Repository{}, err
	}

	var repos []repository.Repository
	if repo.Name != "" {
		repos = []repository.Repository{repo}
	}

	client, err := gh.NewGitHubClientWithRepo(scope)
	if err != nil {
		return nil, repository.Repository{}, err
	}

	var jobs metrics.JobFetcher
	if !skipJobs {
		jobs = m.jobFetcher(client)
	}

	collector := metrics.NewCollector(client, scope, metrics.Options{
		Repos:        repos,
		Window:       window,
		MaxRuns:      m.MaxRuns,
		Concurrency:  m.Concurrency,
		Branch:       m.Branch,
		Event:        m.Event,
		Workflow:     m.Workflow,
		AllRepos:     m.AllRepos,
		IncludeRepos: m.IncludeRepos,
		ExcludeRepos: m.ExcludeRepos,
		SkipJobs:     skipJobs,
		SkipRunners:  skipRunners,
	}, jobs)

	if wantUsage {
		collector.SetUsageFetcher(m.usageFetcher(client))
	}

	return collector, scope, nil
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
