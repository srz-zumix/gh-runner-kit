package metrics

import (
	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewRunnerCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var groupBy string

	cmd := &cobra.Command{
		Use:   "runner",
		Short: "Show per runner activity",
		Long: `Break the fleet activity down per runner, per runs-on label set or per runner group.

Grouping by name gives every registered runner a row, including the ones that picked
up no work at all, which is how idle and cordoned capacity becomes visible. Ephemeral
runners get a fresh name on every job, so group them by label or by group instead.

Utilization divides the busy time of the row by the length of the aggregation window,
and STATUS and CORDONED describe the runner right now rather than during the window.
Jobs that ran on GitHub-hosted runners are excluded.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			rows := metricspkg.BuildRunnerStats(data, metricspkg.Grouping(groupBy))

			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsRunners(r, rows); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.Truncated, data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)
	cmdutil.StringEnumFlag(cmd, &groupBy, "group-by", "", string(metricspkg.GroupByName), metricspkg.Groupings, "Aggregate the jobs by this key")

	return cmd
}
