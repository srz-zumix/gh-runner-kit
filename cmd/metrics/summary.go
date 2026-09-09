package metrics

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewSummaryCmd() *cobra.Command {
	var flags kitutil.MetricsFlags

	cmd := &cobra.Command{
		Use:   "summary",
		Short: "Show a self-hosted runner fleet overview",
		Long: `Summarize how the self-hosted runner fleet behaved over a time window.

The runner counts describe the fleet right now, because the API keeps no history of
when each runner was online. Every job metric covers the window selected by --days or
--since and excludes the jobs that ran on GitHub-hosted runners.

Wait time is measured from the moment a job was created until it started, so it also
includes the time the job spent waiting on needs dependencies and concurrency groups.
Utilization divides the total busy time by the window length multiplied by the number
of registered runners, and the failure rate counts failed and timed out jobs against
the jobs that produced a pass or fail outcome.

Check runs published by apps share the check suite of a workflow run, so the jobs API
returns them alongside the real jobs. They carry no runs-on labels and never occupied
a runner, so they are excluded.

The footer always states the window and the number of runs the report is based on.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			r := render.NewRenderer(flags.Exporter)
			return kitutil.RenderMetricsSummary(r, metricspkg.BuildSummary(data))
		},
	}

	flags.Add(cmd)

	return cmd
}
