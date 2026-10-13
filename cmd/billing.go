package cmd

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/cmd/billing"
)

func NewBillingCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "billing",
		Short: "Report GitHub Actions billing usage of an organization, user or enterprise",
	}

	cmd.AddCommand(billing.NewSummaryCmd())
	cmd.AddCommand(billing.NewUsageCmd())

	return cmd
}

func init() {
	rootCmd.AddCommand(NewBillingCmd())
}
