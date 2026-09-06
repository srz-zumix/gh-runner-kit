package cmd

import (
	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/runnerfields"
	"github.com/srz-zumix/gh-runner-kit/internal/runnerstatus"
	"github.com/srz-zumix/gh-runner-kit/internal/runnertype"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewListCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var runnerType string
	var status string
	var nameOnly bool
	var fields []string
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List self-hosted runners",
		Long: `List self-hosted runners, including their cordon status.

Organization-level runners are listed by default. Use --type repo to list the
runners registered to a repository instead, --status to keep only the runners in
one status, and --fields to choose the table columns.

The runner APIs only report online and offline, so --status active and
--status idle match the online runners that are respectively running a job and
waiting for one.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()

			repo, err := parser.Repository(
				parser.RepositoryOwnerWithHost(ownerFlag),
				parser.RepositoryInput(repoFlag),
			)
			if err != nil {
				return err
			}

			repo, err = runnertype.Apply(cmd, repo, runnerType)
			if err != nil {
				return err
			}

			client, err := gh.NewGitHubClientWithRepo(repo)
			if err != nil {
				return err
			}

			runners, err := gh.ListRunners(ctx, client, repo)
			if err != nil {
				return err
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
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name (for organization-level runners)")
	runnertype.AddFlag(cmd, &runnerType)
	runnerstatus.AddFlag(cmd, &status)
	f.BoolVar(&nameOnly, "name-only", false, "Print only the runner names")
	runnerfields.AddFlag(cmd, &fields)
	cmdutil.AddFormatFlags(cmd, &exporter)

	return cmd
}

func init() {
	rootCmd.AddCommand(NewListCmd())
}
