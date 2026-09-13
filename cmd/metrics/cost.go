package metrics

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewCostCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var rates []string

	cmd := &cobra.Command{
		Use:   "cost",
		Short: "Report the billable time GitHub-hosted runners consumed",
		Long: `Report the billable time of the collected workflow runs, broken down by operating system.

GitHub only bills the jobs it hosted, so self-hosted jobs contribute nothing to this
report. What it shows is therefore both the current hosted spend and what moving the same
work to self-hosted runners would avoid. Public repositories run on hosted runners for
free, so their billable time is reported as zero.

EST COST multiplies the billable minutes by the per-minute price of the operating system.
The defaults are the public prices of the standard two core runners, so pass --rate to
match a plan or a larger runner, for example --rate ubuntu=0.016.

This command reads the usage of every run, which costs one API request per run, so keep
--max-runs in mind. The per run job listing is skipped because the report does not need
it, and completed runs are cached like they are for the other reports.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			priceList, err := metricspkg.ParseRates(rates)
			if err != nil {
				return err
			}

			data, err := flags.CollectUsage(cmd)
			if err != nil {
				return err
			}

			rows := metricspkg.BuildCostStats(data, priceList)

			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsCost(r, rows); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.Truncated, data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)
	cmd.Flags().StringArrayVar(&rates, "rate", nil, "Override the per-minute price of an operating system, as OS=PRICE such as ubuntu=0.008")

	return cmd
}
