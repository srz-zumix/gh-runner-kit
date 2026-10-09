package cmd

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/cmd/hosted"
)

func NewHostedCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "hosted",
		Short: "Manage GitHub-hosted runners",
	}
	cmd.AddCommand(hosted.NewListCmd())
	return cmd
}

func init() {
	rootCmd.AddCommand(NewHostedCmd())
}
