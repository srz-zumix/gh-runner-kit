package metrics

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewConcurrencyCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var bucket string
	var labels []string

	// defaultBucket is the textual --bucket default. It lives here, at the flag boundary,
	// so the help output matches the documented value instead of time.Duration's verbose
	// "1h0m0s" rendering.
	const defaultBucket = "1h"

	cmd := &cobra.Command{
		Use:   "concurrency",
		Short: "Show how many jobs ran at the same time over the window",
		Long: `Reconstruct the number of jobs that occupied a runner at the same time from their
start and completion timestamps, one time bucket at a time.

PEAK is the highest number of jobs running at the same instant inside the bucket, and
comparing it against RUNNERS shows whether the fleet ran out of capacity and when. UTIL
is the busy time of the bucket divided by the bucket length times RUNNERS, so it stays
comparable across buckets even though the last one is cut off at the end of the window.

--label keeps only the jobs whose runs-on set carries every given label, and counts
only the runners that can serve that set. Jobs that ran on GitHub-hosted runners are
excluded.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			width, err := time.ParseDuration(bucket)
			if err != nil {
				return fmt.Errorf("failed to parse --bucket %q: %w", bucket, err)
			}
			if width <= 0 {
				return fmt.Errorf("--bucket must be greater than 0, got %s", bucket)
			}

			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			rows := metricspkg.BuildConcurrencyStats(data, width, labels)

			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsConcurrency(r, rows); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.Truncated, data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)
	cmd.Flags().StringVar(&bucket, "bucket", defaultBucket, "Width of one time bucket, such as 15m or 1h")
	cmd.Flags().StringArrayVar(&labels, "label", nil, "Keep only the jobs requesting this label (repeatable)")

	return cmd
}
