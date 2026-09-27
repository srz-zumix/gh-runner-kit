package metrics

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
)

func NewCollectCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var usage bool
	var output string

	cmd := &cobra.Command{
		Use:   "collect",
		Short: "Collect the workflow activity every other metrics command reports from",
		Long: `Collect the runner inventory, the workflow runs and their jobs once, and write the
result to a snapshot file.

Every other metrics command accepts the resulting file through --input instead of
issuing its own API requests, so a fleet dashboard that runs several reports over the
same window pays for the collection only once instead of once per report.

--usage additionally reads the billable time of every run, which costs one extra API
request per run, so that the resulting snapshot can also serve "metrics cost --input".

The snapshot is written to --output, "-" for stdout by default, and gzip-compressed
when the name ends in .gz.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			snap, err := flags.CollectSnapshot(cmd, usage)
			if err != nil {
				return err
			}
			if err := metricspkg.WriteSnapshot(output, snap); err != nil {
				return fmt.Errorf("failed to write the snapshot to %s: %w", output, err)
			}
			logger.Info("metrics: wrote the snapshot", "output", output, "runs", len(snap.Data.Runs), "jobs", len(snap.Data.Jobs), "usage", usage)
			return nil
		},
	}

	flags.Add(cmd, kitutil.WithoutInputFlag(), kitutil.WithoutFormatFlags())
	cmd.Flags().BoolVar(&usage, "usage", false, "Also collect the billable usage of every run, for metrics cost --input")
	cmd.Flags().StringVar(&output, "output", "-", "Write the snapshot to this file instead of stdout")

	return cmd
}
