package metrics

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewQueueCmd() *cobra.Command {
	var flags kitutil.MetricsFlags

	cmd := &cobra.Command{
		Use:   "queue",
		Short: "Show how long each runs-on label set waited",
		Long: `Group the jobs by the runs-on label set they requested and report how long each set
waited for a runner.

RUNNERS counts the registered runners that carry every label of the set, PEAK is the
highest number of jobs of that set which ran at the same time, and SATURATION is PEAK
divided by RUNNERS. A saturation above 1.00 combined with a high WAIT P95 means the
label set asked for more runners at once than it has, so adding capacity would cut the
wait time. A low saturation with a high wait instead points at the jobs themselves,
for example at needs dependencies or concurrency groups, because the wait time is
measured from job creation and not from the moment the job became runnable.

Jobs that ran on GitHub-hosted runners are excluded.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsQueue(r, metricspkg.BuildQueueStats(data)); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.Truncated, data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)

	return cmd
}
