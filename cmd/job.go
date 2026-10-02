package cmd

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/cmd/job"
)

func NewJobCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "job",
		Short: "Inspect the jobs of a workflow run",
	}

	cmd.AddCommand(job.NewTimelineCmd())

	return cmd
}

func init() {
	rootCmd.AddCommand(NewJobCmd())
}
