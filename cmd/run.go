package cmd

import (
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"

	runnerpkg "github.com/srz-zumix/gh-runner-kit/pkg/runner"
)

func NewRunCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var name string
	var labels string
	var noDefaultLabels bool
	var runnerGroup string
	var workDir string
	var installDir string
	var version string
	var replace bool
	var ephemeral bool
	var removeOnExit bool

	cmd := &cobra.Command{
		Use:   "run",
		Short: "Download, register and run a self-hosted runner agent",
		Long: `Run downloads the actions/runner agent (if not already present in --dir),
registers it with the target repository or organization, and runs it in the
foreground. Press Ctrl+C to stop the runner.

Use --no-default-labels to register the runner with only the labels given by
--labels. The runner name is used as the label when --labels is omitted.

Use --runner-group to register an organization runner into an existing runner
group instead of the default one.

Use --remove-on-exit to delete the runner registration from GitHub once the
agent has stopped, leaving the downloaded agent in --dir.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()

			repo, err := parser.Repository(
				parser.RepositoryOwnerWithHost(ownerFlag),
				parser.RepositoryInput(repoFlag),
			)
			if err != nil {
				return err
			}

			if runnerGroup != "" && repo.Name != "" {
				return errors.New("--runner-group is only supported for organization-level runners, so use --owner instead of --repo")
			}

			client, err := gh.NewGitHubClientWithRepo(repo)
			if err != nil {
				return err
			}

			if name == "" {
				name, err = os.Hostname()
				if err != nil {
					return fmt.Errorf("failed to determine runner name: %w", err)
				}
			}

			if noDefaultLabels && labels == "" {
				labels = name
			}

			if !runnerpkg.IsConfigured(installDir) {
				platform, err := runnerpkg.Platform()
				if err != nil {
					return err
				}

				resolvedVersion := version
				if resolvedVersion == "" || resolvedVersion == "latest" {
					resolvedVersion, err = runnerpkg.LatestVersion(ctx)
					if err != nil {
						return err
					}
				}

				logger.Info("downloading actions/runner", "version", resolvedVersion, "platform", platform, "dir", installDir)
				if err := runnerpkg.Download(ctx, installDir, platform, resolvedVersion); err != nil {
					return err
				}
			}

			if !runnerpkg.IsConfigured(installDir) || replace {
				token, err := gh.CreateRegistrationToken(ctx, client, repo)
				if err != nil {
					return err
				}

				logger.Info("registering runner", "name", name, "target", parser.GetRepositoryFullNameWithHost(repo))
				if err := runnerpkg.Configure(installDir, runnerpkg.ConfigOptions{
					URL:             parser.GetRepositoryURL(repo),
					Token:           token.GetToken(),
					Name:            name,
					Labels:          labels,
					NoDefaultLabels: noDefaultLabels,
					RunnerGroup:     runnerGroup,
					WorkDir:         workDir,
					Replace:         replace,
					Ephemeral:       ephemeral,
				}); err != nil {
					return err
				}
			} else {
				logger.Info("runner already registered, skipping configuration", "dir", installDir)
			}

			logger.Info("starting runner", "name", name)
			runErr := runnerpkg.Run(installDir)
			if !removeOnExit {
				return runErr
			}

			logger.Info("removing runner registration", "name", name)
			token, err := gh.CreateRemoveToken(ctx, client, repo)
			if err != nil {
				return errors.Join(runErr, fmt.Errorf("failed to create a remove token for %s: %w", parser.GetRepositoryFullNameWithHost(repo), err))
			}
			if err := runnerpkg.Unconfigure(installDir, token.GetToken()); err != nil {
				return errors.Join(runErr, fmt.Errorf("failed to remove the registration of runner %s: %w", name, err))
			}
			return runErr
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name (for organization-level runners)")
	f.StringVar(&name, "name", "", "Runner name (defaults to the hostname when omitted)")
	f.StringVar(&labels, "labels", "", "Comma-separated custom labels; with --no-default-labels, the runner name is used when omitted")
	f.BoolVar(&noDefaultLabels, "no-default-labels", false, "Register the runner without the default labels (self-hosted, OS and architecture)")
	f.StringVar(&runnerGroup, "runner-group", "", "Runner group to register the runner into (organization-level runners only; the runner agent uses \"Default\" when omitted)")
	f.StringVar(&workDir, "work", "", "Working directory used by the runner agent (uses \"_work\" when omitted)")
	f.StringVar(&installDir, "dir", ".actions-runner", "Directory to install and run the runner agent in")
	f.StringVar(&version, "version", "latest", "actions/runner version to download")
	f.BoolVar(&replace, "replace", false, "Replace any existing runner registration with the same name")
	f.BoolVar(&ephemeral, "ephemeral", false, "Register the runner as ephemeral (it deregisters itself after one job)")
	f.BoolVar(&removeOnExit, "remove-on-exit", false, "Delete the runner registration from GitHub after the agent stops")

	return cmd
}

func init() {
	rootCmd.AddCommand(NewRunCmd())
}
