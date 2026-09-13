package cmd

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/cmd/metrics"
)

func NewMetricsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "metrics",
		Short: "Report runner utilization, queue time, concurrency, label demand, capacity, cost and per-workflow activity",
	}

	cmd.AddCommand(metrics.NewCapacityCmd())
	cmd.AddCommand(metrics.NewConcurrencyCmd())
	cmd.AddCommand(metrics.NewCostCmd())
	cmd.AddCommand(metrics.NewExportCmd())
	cmd.AddCommand(metrics.NewLabelCmd())
	cmd.AddCommand(metrics.NewQueueCmd())
	cmd.AddCommand(metrics.NewRunnerCmd())
	cmd.AddCommand(metrics.NewSummaryCmd())
	cmd.AddCommand(metrics.NewWorkflowCmd())

	return cmd
}

func init() {
	rootCmd.AddCommand(NewMetricsCmd())
}
