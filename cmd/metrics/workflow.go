package metrics

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewWorkflowCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var selfHostedOnly bool

	cmd := &cobra.Command{
		Use:   "workflow",
		Short: "Show the failure rate and the duration of each workflow",
		Long: `Break the collected jobs down per workflow.

RETRY is the share of runs that were restarted at least once, which is the only retry
signal the API exposes: the job list of a run only ever covers its last attempt, so a
job that was retried inside a single attempt cannot be told apart from a job that ran
once. FAIL counts the jobs that failed or timed out against the jobs that reached a
verdict, so cancelled jobs do not make a workflow look broken.

Unlike the other metrics reports this one includes the jobs that ran on GitHub-hosted
runners, so that a workflow can be judged as a whole. Pass --self-hosted-only to narrow
it down to the fleet, and --workflow to collect a single workflow file to begin with.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			rows := metricspkg.BuildWorkflowStats(data, selfHostedOnly)

			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsWorkflows(r, rows); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.Truncated, data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)
	cmd.Flags().BoolVar(&selfHostedOnly, "self-hosted-only", false, "Exclude the jobs that ran on GitHub-hosted runners")

	return cmd
}
