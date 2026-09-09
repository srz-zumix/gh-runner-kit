package cmd

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/cmd/metrics"
)

func NewMetricsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "metrics",
		Short: "Report self-hosted runner utilization and queue time",
	}

	cmd.AddCommand(metrics.NewQueueCmd())
	cmd.AddCommand(metrics.NewRunnerCmd())
	cmd.AddCommand(metrics.NewSummaryCmd())

	return cmd
}

func init() {
	rootCmd.AddCommand(NewMetricsCmd())
}
