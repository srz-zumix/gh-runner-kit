package group

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/cmd/group/runner"
)

func NewRunnerCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "runner",
		Short: "Manage the self-hosted runners of an organization runner group",
	}

	cmd.AddCommand(runner.NewAddCmd())
	cmd.AddCommand(runner.NewListCmd())
	cmd.AddCommand(runner.NewRemoveCmd())

	return cmd
}
