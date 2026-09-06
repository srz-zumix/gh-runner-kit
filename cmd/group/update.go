package group

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewUpdateCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var name string
	var visibility string
	var allowsPublicRepositories bool
	var dryRun bool
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "update <group>",
		Short: "Update the settings of an organization runner group",
		Long: `Update the settings of an organization runner group.

The runner group is selected by name or by ID. Only the settings given on the
command line are changed, and at least one of them is required.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Managing runner groups requires organization owner permission.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			selector := args[0]

			repo, client, err := kitutil.ResolveOrganization(ownerFlag, repoFlag)
			if err != nil {
				return err
			}

			group, err := kitutil.FindRunnerGroup(ctx, client, repo, selector)
			if err != nil {
				return err
			}

			settings := gh.RunnerGroupSettings{}
			if cmd.Flags().Changed("name") {
				settings.Name = &name
			}
			if cmd.Flags().Changed("visibility") {
				settings.Visibility = &visibility
			}
			if cmd.Flags().Changed("allows-public-repositories") {
				settings.AllowsPublicRepositories = &allowsPublicRepositories
			}

			if dryRun {
				logger.Info("[dryrun] would update runner group", "name", group.GetName(), "id", group.GetID())
				return nil
			}

			updated, err := gh.UpdateOrgRunnerGroup(ctx, client, repo, group.GetID(), settings)
			if err != nil {
				return fmt.Errorf("failed to update runner group %q in %s: %w", selector, repo.Owner, err)
			}

			logger.Info("updated runner group", "name", updated.GetName(), "id", updated.GetID())
			return render.NewRenderer(exporter).RenderRunnerGroup(updated, nil)
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	f.StringVar(&name, "name", "", "Rename the runner group")
	cmdutil.StringEnumFlag(cmd, &visibility, "visibility", "", "", []string{"selected", "all", "private"}, "Which repositories can use the runner group")
	f.BoolVar(&allowsPublicRepositories, "allows-public-repositories", false, "Let public repositories use the runner group")
	f.BoolVarP(&dryRun, "dryrun", "n", false, "Show what would be done without making any changes")
	cmdutil.AddFormatFlags(cmd, &exporter)
	cmd.MarkFlagsOneRequired("name", "visibility", "allows-public-repositories")

	return cmd
}
