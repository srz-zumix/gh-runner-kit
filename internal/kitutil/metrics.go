package kitutil

import (
	"time"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
)

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

// Add registers the shared metrics flags on cmd.
func (m *MetricsFlags) Add(cmd *cobra.Command) {
	f := cmd.Flags()
	f.StringVarP(&m.Repo, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&m.Owner, "owner", "", "Select an organization by owner name")
	AddTypeFlag(cmd, &m.Type)
	f.IntVar(&m.Days, "days", metrics.DefaultDays, "Aggregate over the last N days")
	f.StringVar(&m.Since, "since", "", "Aggregate since this time, as YYYY-MM-DD or RFC3339 (cannot be used with --days)")
	f.IntVar(&m.MaxRuns, "max-runs", metrics.DefaultMaxRuns, "Stop after retrieving this many workflow runs per scope (0 for no limit)")
	f.IntVar(&m.Concurrency, "concurrency", metrics.DefaultConcurrency, "Number of job requests to issue in parallel")
	f.StringVar(&m.Branch, "branch", "", "Keep only the workflow runs of this branch")
	f.StringVar(&m.Event, "event", "", "Keep only the workflow runs triggered by this event")
	f.StringVar(&m.Workflow, "workflow", "", "Keep only the runs of this workflow file, such as ci.yml")
	f.BoolVar(&m.AllRepos, "all-repos", false, "Collect the workflow runs of every repository in the organization")
	f.BoolVar(&m.NoCache, "no-cache", false, "Do not read or write the local job cache")
	f.BoolVar(&m.Refresh, "refresh", false, "Ignore the cached jobs and fetch them again")
	cmdutil.AddFormatFlags(cmd, &m.Exporter)

	cmd.MarkFlagsMutuallyExclusive("days", "since")
}

// Window resolves the aggregation window from the --days/--since flags. Commands that must
// validate the window before collecting data can call this first and hand the result to
// CollectWithWindow, so validation and collection agree on a single window.
func (m *MetricsFlags) Window() (metrics.Window, error) {
	return metrics.ParseWindow(m.Days, m.Since, time.Now())
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

	collector := metrics.NewCollector(client, scope, metrics.Options{
		Repos:       repos,
		Window:      window,
		MaxRuns:     m.MaxRuns,
		Concurrency: m.Concurrency,
		Branch:      m.Branch,
		Event:       m.Event,
		Workflow:    m.Workflow,
		AllRepos:    m.AllRepos,
	}, m.jobFetcher(client))

	return collector.Collect(ctx)
}

// jobFetcher wraps the API fetcher with the on-disk cache unless it is disabled or
// unavailable. The cache scopes each entry per repository, so a single instance is
// safe to share across a repository collection.
func (m *MetricsFlags) jobFetcher(client *gh.GitHubClient) metrics.JobFetcher {
	fetcher := metrics.JobFetcher(metrics.NewAPIJobFetcher(client))
	if m.NoCache {
		return fetcher
	}

	cache, err := metrics.NewCache()
	if err != nil {
		logger.Warn("metrics: continuing without the job cache", "error", err)
		return fetcher
	}
	return metrics.NewCachedJobFetcher(fetcher, cache, m.Refresh)
}
