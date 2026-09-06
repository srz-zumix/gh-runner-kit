package cmd

import (
	"os"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/version"
	"github.com/srz-zumix/go-gh-extension/pkg/actions"
	"github.com/srz-zumix/go-gh-extension/pkg/cmdflags"
)

var rootCmd = &cobra.Command{
	Use:     "gh-runner-kit",
	Short:   "Manage GitHub Actions self-hosted runners",
	Long:    `gh-runner-kit is a GitHub CLI extension for managing self-hosted Actions runners.`,
	Version: version.Version,
}

func init() {
	if actions.IsRunsOn() {
		rootCmd.SetErrPrefix(actions.GetErrorPrefix())
	}
	cmdflags.AddPersistentFlags(rootCmd)
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
