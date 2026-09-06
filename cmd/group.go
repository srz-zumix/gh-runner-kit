package cmd

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/cmd/group"
)

func NewGroupCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "group",
		Short: "Manage organization runner groups",
	}

	cmd.AddCommand(group.NewCreateCmd())
	cmd.AddCommand(group.NewDeleteCmd())
	cmd.AddCommand(group.NewListCmd())
	cmd.AddCommand(group.NewReposCmd())
	cmd.AddCommand(group.NewRunnerCmd())
	cmd.AddCommand(group.NewUpdateCmd())
	cmd.AddCommand(group.NewViewCmd())

	return cmd
}

func init() {
	rootCmd.AddCommand(NewGroupCmd())
}
