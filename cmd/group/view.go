package group

import (
	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/runnergroup"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewViewCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var fields []string
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "view <group>",
		Short: "Show the settings of an organization runner group",
		Long: `Show the settings of an organization runner group.

The runner group is selected by name or by ID.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Reading runner groups requires organization owner permission.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()

			repo, client, err := runnergroup.Organization(ownerFlag, repoFlag)
			if err != nil {
				return err
			}

			group, err := runnergroup.Find(ctx, client, repo, args[0])
			if err != nil {
				return err
			}

			return render.NewRenderer(exporter).RenderRunnerGroup(group, fields)
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	cmdutil.StringSliceEnumFlag(cmd, &fields, "fields", "", nil, render.RunnerGroupFields(), "Fields to display")
	cmdutil.AddFormatFlags(cmd, &exporter)

	return cmd
}
