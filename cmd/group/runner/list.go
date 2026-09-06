package runner

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/runnerfields"
	"github.com/srz-zumix/gh-runner-kit/internal/runnergroup"
	"github.com/srz-zumix/gh-runner-kit/internal/runnerstatus"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewListCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var status string
	var nameOnly bool
	var fields []string
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "list <group>",
		Short: "List the self-hosted runners of an organization runner group",
		Long: `List the self-hosted runners belonging to an organization runner group.

The runner group is selected by name or by ID.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Reading runner groups requires organization owner permission.

Use --status to keep only the runners in one status, and --fields to choose the
table columns.

The runner APIs only report online and offline, so --status active and
--status idle match the online runners that are respectively running a job and
waiting for one.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			groupSelector := args[0]

			repo, client, err := runnergroup.Organization(ownerFlag, repoFlag)
			if err != nil {
				return err
			}

			group, err := runnergroup.Find(ctx, client, repo, groupSelector)
			if err != nil {
				return err
			}

			runners, err := gh.ListOrgRunnerGroupRunners(ctx, client, repo, group.GetID())
			if err != nil {
				return fmt.Errorf("failed to list the runners of runner group %q: %w", group.GetName(), err)
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
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	runnerstatus.AddFlag(cmd, &status)
	f.BoolVar(&nameOnly, "name-only", false, "Print only the runner names")
	runnerfields.AddFlag(cmd, &fields)
	cmdutil.AddFormatFlags(cmd, &exporter)

	return cmd
}
