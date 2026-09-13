package metrics

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewCapacityCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var targetWait string
	var targetUtilization float64

	cmd := &cobra.Command{
		Use:   "capacity",
		Short: "Recommend how many runners each runs-on label set needs",
		Long: `Size every runs-on label set against a target queue time.

LOAD is the offered load in Erlangs: the number of runners the label set kept busy on
average across the window. RECOMMENDED is the smallest pool that keeps both the modelled
mean queue time at or below --target-wait and the utilization at or below
--target-utilization, and DELTA is how many runners to add, or to remove when negative.

The model is an M/M/c queue, which assumes jobs arrive independently of each other and
that any runner of the pool can serve any of its jobs. Workloads driven by a scheduled
burst or by fan-out inside a single workflow break the first assumption, so compare
EST WAIT against the measured WAIT P95 before acting on DELTA.

Jobs that ran on GitHub-hosted runners are excluded.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			wait, err := flags.ResolveCapacity(targetWait, targetUtilization)
			if err != nil {
				return err
			}

			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			rows := metricspkg.BuildCapacityStats(data, wait, targetUtilization)

			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsCapacity(r, rows); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.Truncated, data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)
	cmd.Flags().StringVar(&targetWait, "target-wait", metricspkg.DefaultTargetWait.String(), "Mean queue time the recommended pool aims for, such as 60s")
	cmd.Flags().Float64Var(&targetUtilization, "target-utilization", metricspkg.DefaultTargetUtilization, "Highest share of the time a runner may be busy, between 0 and 1")

	return cmd
}
