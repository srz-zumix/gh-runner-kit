package cmd

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/cmd/copilot"
)

// NewCopilotCmd creates the command for managing GitHub Copilot integrations.
func NewCopilotCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "copilot",
		Short: "Manage GitHub Copilot integrations",
	}

	cmd.AddCommand(copilot.NewExtensionCmd())

	return cmd
}

func init() {
	rootCmd.AddCommand(NewCopilotCmd())
}
