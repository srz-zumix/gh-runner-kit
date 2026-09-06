package cmd

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/runnerfields"
	"github.com/srz-zumix/gh-runner-kit/internal/runnerstatus"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewAvailableCmd() *cobra.Command {
	var repoFlag, status string
	var nameOnly bool
	var fields []string
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "available",
		Short: "List self-hosted runners available to a repository",
		Long: `List every self-hosted runner a repository can schedule jobs on: the runners
registered to the repository itself plus the organization runners belonging to
each runner group that is visible to the repository.

Use --status to keep only the runners in one status, and --fields to choose the
table columns.

The runner APIs only report online and offline, so --status active and
--status idle match the online runners that are respectively running a job and
waiting for one.

Listing the organization runner groups requires organization owner permission.
Runner groups are an organization feature, so only the repository-level runners
are listed for a user-owned repository.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()

			repo, err := parser.Repository(parser.RepositoryInput(repoFlag))
			if err != nil {
				return err
			}
			if repo.Name == "" {
				return fmt.Errorf("a repository is required: use --repo, or run inside a repository")
			}

			client, err := gh.NewGitHubClientWithRepo(repo)
			if err != nil {
				return err
			}

			runners, err := gh.ListAvailableRunners(ctx, client, repo)
			if err != nil {
				return fmt.Errorf("failed to list runners available to %s: %w", parser.GetRepositoryFullNameWithHost(repo), err)
			}
			runners = runnerstatus.Filter(runners, status)

			r := render.NewRenderer(exporter)
			if nameOnly {
				return r.RenderNames(runners)
			}
			return r.RenderRunnersWithFieldGetters(runners, runnerfields.Headers(fields), runnerfields.Getters())
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	runnerstatus.AddFlag(cmd, &status)
	f.BoolVar(&nameOnly, "name-only", false, "Print only the runner names")
	runnerfields.AddFlag(cmd, &fields)
	cmdutil.AddFormatFlags(cmd, &exporter)

	return cmd
}

func init() {
	rootCmd.AddCommand(NewAvailableCmd())
}
