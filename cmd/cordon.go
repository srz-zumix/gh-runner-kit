package cmd

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	runnerpkg "github.com/srz-zumix/gh-runner-kit/pkg/runner"
	"github.com/srz-zumix/go-gh-extension/pkg/cmdflags"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
)

func NewCordonCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var runnerType string
	var runnerID int64
	var runnerName string
	var runnerLabel string
	var strategy string
	var groupName string
	var groupVisibility string
	var labelPrefix string
	var dryRun bool

	cmd := &cobra.Command{
		Use:   "cordon",
		Short: "Cordon self-hosted runners so they stop receiving new jobs",
		Long: `Cordon marks self-hosted runners so that no new jobs will be scheduled on them,
without deleting the runner registration.

Runners are selected with --id, --name or --label. --label cordons every runner
that carries the given label. Organization-level runners are targeted by default;
use --type repo (or --repo) to target the runners of a repository.

Two strategies are available:
  - group (default, organization-level only): moves the runner into an isolated
    runner group with restricted visibility so no "runs-on:" in any repository
    can match it.
  - label: renames the runner's custom labels with a "cordoned-" prefix so
    "runs-on:" references using those custom labels no longer match. This does
    not remove the built-in "self-hosted"/OS/architecture labels, so a workflow
    using only "runs-on: self-hosted" can still match the runner.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()

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

			if strategy != "group" && strategy != "label" {
				return fmt.Errorf("invalid --strategy %q: expected \"group\" or \"label\"", strategy)
			}
			if strategy == "group" && repo.Name != "" {
				return fmt.Errorf("--strategy group is only supported for organization-level runners; use --type org, or use --strategy label")
			}

			client, err := gh.NewGitHubClientWithRepo(repo)
			if err != nil {
				return err
			}

			runners, err := runnerpkg.Select(ctx, client, repo, runnerpkg.SelectOptions{
				ID:    runnerID,
				Name:  runnerName,
				Label: runnerLabel,
			})
			if err != nil {
				return err
			}
			if len(runners) == 0 {
				logger.Warn("no runners matched")
				return nil
			}

			for _, runner := range runners {
				if runnerpkg.IsCordoned(runner) {
					logger.Warn("runner is already cordoned", "name", runner.GetName(), "id", runner.GetID())
					continue
				}

				if dryRun {
					logger.Info("[dryrun] would cordon runner", "name", runner.GetName(), "id", runner.GetID(), "strategy", strategy)
					continue
				}

				switch strategy {
				case "group":
					if err := runnerpkg.CordonByGroup(ctx, client, repo, runner, groupName, groupVisibility); err != nil {
						return fmt.Errorf("failed to cordon runner %s: %w", runner.GetName(), err)
					}
				case "label":
					if err := runnerpkg.CordonByLabel(ctx, client, repo, runner, labelPrefix); err != nil {
						return fmt.Errorf("failed to cordon runner %s: %w", runner.GetName(), err)
					}
				}

				logger.Info("cordoned runner", "name", runner.GetName(), "id", runner.GetID())
			}
			return nil
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name (for organization-level runners)")
	kitutil.AddTypeFlag(cmd, &runnerType)
	f.Int64Var(&runnerID, "id", 0, "Select the runner to cordon by ID")
	f.StringVar(&runnerName, "name", "", "Select the runner to cordon by name")
	f.StringVar(&runnerLabel, "label", "", "Select every runner that has this label")
	f.StringVar(&strategy, "strategy", "group", "Cordon strategy: {group|label}")
	f.StringVar(&groupName, "group", runnerpkg.DefaultCordonGroupName, "Name of the isolated runner group used by the \"group\" strategy")
	f.StringVar(&groupVisibility, "group-visibility", "selected", "Visibility of the isolated runner group when it is created: {selected|all|private}")
	cmdflags.NonEmptyStringVar(cmd, &labelPrefix, "label-prefix", "cordoned-", "Prefix applied to custom labels by the \"label\" strategy")
	f.BoolVarP(&dryRun, "dryrun", "n", false, "Show what would be done without making any changes")
	cmd.MarkFlagsOneRequired("id", "name", "label")
	cmd.MarkFlagsMutuallyExclusive("id", "name", "label")

	return cmd
}

func init() {
	rootCmd.AddCommand(NewCordonCmd())
}
