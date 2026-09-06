package group

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/runnergroup"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewCreateCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var visibility string
	var allowsPublicRepositories bool
	var dryRun bool
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "create <name>",
		Short: "Create an organization runner group",
		Long: `Create a runner group in an organization.

The group is created without any repository access, so grant it afterwards from
the organization settings unless --visibility all is used.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Managing runner groups requires organization owner permission.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			name := args[0]

			repo, client, err := runnergroup.Organization(ownerFlag, repoFlag)
			if err != nil {
				return err
			}

			if dryRun {
				logger.Info("[dryrun] would create runner group", "name", name, "owner", repo.Owner, "visibility", visibility)
				return nil
			}

			settings := gh.RunnerGroupSettings{
				Name:                     &name,
				Visibility:               &visibility,
				AllowsPublicRepositories: &allowsPublicRepositories,
			}
			group, err := gh.CreateOrgRunnerGroupWithSettings(ctx, client, repo, settings)
			if err != nil {
				return fmt.Errorf("failed to create runner group %q in %s: %w", name, repo.Owner, err)
			}

			logger.Info("created runner group", "name", group.GetName(), "id", group.GetID())
			return render.NewRenderer(exporter).RenderRunnerGroup(group, nil)
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	cmdutil.StringEnumFlag(cmd, &visibility, "visibility", "", "selected", []string{"selected", "all", "private"}, "Which repositories can use the runner group")
	f.BoolVar(&allowsPublicRepositories, "allows-public-repositories", false, "Let public repositories use the runner group")
	f.BoolVarP(&dryRun, "dryrun", "n", false, "Show what would be done without making any changes")
	cmdutil.AddFormatFlags(cmd, &exporter)

	return cmd
}
