package group

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/runnergroup"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewListCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var nameOnly bool
	var fields []string
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List organization runner groups",
		Long: `List the runner groups configured in an organization.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Reading runner groups requires organization owner permission.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()

			repo, client, err := runnergroup.Organization(ownerFlag, repoFlag)
			if err != nil {
				return err
			}

			groups, err := gh.ListOrgRunnerGroups(ctx, client, repo)
			if err != nil {
				return fmt.Errorf("failed to list runner groups of %s: %w", repo.Owner, err)
			}

			r := render.NewRenderer(exporter)
			if nameOnly {
				return r.RenderNames(groups)
			}
			return r.RenderRunnerGroups(groups, fields)
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	f.BoolVar(&nameOnly, "name-only", false, "Print only the runner group names")
	cmdutil.StringSliceEnumFlag(cmd, &fields, "fields", "", nil, render.RunnerGroupFields(), "Table columns to display")
	cmdutil.AddFormatFlags(cmd, &exporter)

	return cmd
}
