package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	runnerpkg "github.com/srz-zumix/gh-runner-kit/pkg/runner"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
)

func NewUncordonCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var runnerType string
	var runnerID int64
	var runnerName string
	var runnerLabel string
	var all bool
	var labelPrefix string
	var dryRun bool

	cmd := &cobra.Command{
		Use:   "uncordon",
		Short: "Uncordon self-hosted runners so they can receive new jobs again",
		Long: `Uncordon reverses a previous cordon operation, restoring each runner's
original runner group and/or custom labels based on the marker labels recorded
by the "cordon" command.

Runners are selected with --id, --name, --label or --all. --all uncordons every
currently cordoned runner. Organization-level runners are targeted by default;
use --type repo (or --repo) to target the runners of a repository.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()

			if err := kitutil.ValidateSelector(cmd, runnerID, runnerName, runnerLabel); err != nil {
				return err
			}

			repo, err := parser.Repository(
				parser.RepositoryOwnerWithHost(ownerFlag),
				parser.RepositoryInput(repoFlag),
			)
			if err != nil {
				return err
			}

			repo, err = kitutil.ApplyRunnerType(cmd, repo, runnerType)
			if err != nil {
				return err
			}

			client, err := gh.NewGitHubClientWithRepo(repo)
			if err != nil {
				return err
			}

			sel := runnerpkg.SelectOptions{
				ID:    runnerID,
				Name:  runnerName,
				Label: runnerLabel,
			}
			if all {
				sel = runnerpkg.SelectOptions{Label: runnerpkg.CordonMarkerLabel}
			}

			runners, err := runnerpkg.Select(ctx, client, repo, sel)
			if err != nil {
				return err
			}
			if len(runners) == 0 {
				logger.Warn("no runners matched")
				return nil
			}

			for _, runner := range runners {
				if !runnerpkg.IsCordoned(runner) {
					logger.Warn("runner is not cordoned", "name", runner.GetName(), "id", runner.GetID())
					continue
				}

				if dryRun {
					logger.Info("[dryrun] would uncordon runner", "name", runner.GetName(), "id", runner.GetID())
					continue
				}

				if err := runnerpkg.Uncordon(ctx, client, repo, runner, labelPrefix); err != nil {
					return fmt.Errorf("failed to uncordon runner %s: %w", runner.GetName(), err)
				}

				logger.Info("uncordoned runner", "name", runner.GetName(), "id", runner.GetID())
			}
			return nil
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name (for organization-level runners)")
	kitutil.AddTypeFlag(cmd, &runnerType)
	f.Int64Var(&runnerID, "id", 0, "Select the runner to uncordon by ID")
	f.StringVar(&runnerName, "name", "", "Select the runner to uncordon by name")
	f.StringVar(&runnerLabel, "label", "", "Select every runner that has this label")
	f.BoolVar(&all, "all", false, "Select every currently cordoned runner")
	f.StringVar(&labelPrefix, "label-prefix", "cordoned-", "Prefix that was applied to custom labels by the \"label\" strategy")
	f.BoolVarP(&dryRun, "dryrun", "n", false, "Show what would be done without making any changes")
	cmd.MarkFlagsOneRequired("id", "name", "label", "all")
	cmd.MarkFlagsMutuallyExclusive("id", "name", "label", "all")

	return cmd
}

func init() {
	rootCmd.AddCommand(NewUncordonCmd())
}
