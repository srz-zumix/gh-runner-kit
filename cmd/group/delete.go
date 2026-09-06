package group

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/runnergroup"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
)

func NewDeleteCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var dryRun bool

	cmd := &cobra.Command{
		Use:   "delete <group>",
		Short: "Delete an organization runner group",
		Long: `Delete an organization runner group.

The runner group is selected by name or by ID. The runners of the group are not
deleted; they are returned to the default runner group.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Managing runner groups requires organization owner permission.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			selector := args[0]

			repo, client, err := runnergroup.Organization(ownerFlag, repoFlag)
			if err != nil {
				return err
			}

			group, err := runnergroup.Find(ctx, client, repo, selector)
			if err != nil {
				return err
			}

			if dryRun {
				logger.Info("[dryrun] would delete runner group", "name", group.GetName(), "id", group.GetID())
				return nil
			}

			if err := gh.DeleteOrgRunnerGroup(ctx, client, repo, group.GetID()); err != nil {
				return fmt.Errorf("failed to delete runner group %q in %s: %w", selector, repo.Owner, err)
			}

			logger.Info("deleted runner group", "name", group.GetName(), "id", group.GetID())
			return nil
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	f.BoolVarP(&dryRun, "dryrun", "n", false, "Show what would be done without making any changes")

	return cmd
}
