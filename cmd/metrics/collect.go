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

--all-attempts also collects earlier attempts of each selected run, deduplicating
carried-over jobs by job ID. Unavailable historical jobs are reported as warnings.

--pricing reads repository visibility and current hosted machine inventory without
requesting per-run billable usage. --usage includes pricing as well.

--usage additionally reads per-run billable usage, repository visibility and current
hosted-runner definitions, including pools inherited from enterprise runner groups,
so that the snapshot can also serve "metrics cost --input".
It costs one extra usage request per run plus inventory requests.

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
	cmd.Flags().BoolVar(&usage, "usage", false, "Also collect billable usage, visibility and hosted machine inventory for metrics cost --input")
	cmd.Flags().BoolVar(&flags.AllAttempts, "all-attempts", false, "Include jobs and metadata from every attempt of the selected runs")
	cmd.Flags().BoolVar(&flags.Pricing, "pricing", false, "Collect visibility and hosted machine inventory without per-run billable usage")
	cmd.Flags().StringVar(&output, "output", "-", "Write the snapshot to this file instead of stdout")

	return cmd
}
