package runner

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
)

func NewAddCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var dryRun bool

	cmd := &cobra.Command{
		Use:   "add <group> <runner>",
		Short: "Add a self-hosted runner to an organization runner group",
		Long: `Move an organization self-hosted runner into a runner group.

The runner group and the runner are both selected by name or by ID. A runner
belongs to exactly one group, so it is removed from its current group.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Managing runner groups requires organization owner permission.`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			groupSelector, runnerSelector := args[0], args[1]

			repo, client, err := kitutil.ResolveOrganization(ownerFlag, repoFlag)
			if err != nil {
				return err
			}

			group, err := kitutil.FindRunnerGroup(ctx, client, repo, groupSelector)
			if err != nil {
				return err
			}

			runner, err := kitutil.FindOrgRunner(ctx, client, repo, runnerSelector)
			if err != nil {
				return err
			}

			if dryRun {
				logger.Info("[dryrun] would add runner to runner group", "runner", runner.GetName(), "id", runner.GetID(), "group", group.GetName())
				return nil
			}

			if err := gh.AddOrgRunnerGroupRunner(ctx, client, repo, group.GetID(), runner.GetID()); err != nil {
				return fmt.Errorf("failed to add runner %q to runner group %q: %w", runner.GetName(), group.GetName(), err)
			}

			logger.Info("added runner to runner group", "runner", runner.GetName(), "id", runner.GetID(), "group", group.GetName())
			return nil
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	f.BoolVarP(&dryRun, "dryrun", "n", false, "Show what would be done without making any changes")

	return cmd
}
