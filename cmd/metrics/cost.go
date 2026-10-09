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
		Long: `Estimate GitHub-hosted execution costs by billing SKU and machine specification.

Standard runner labels and organization Larger-runner definitions select current USD
list prices, including architecture and GPU variants. Each job is rounded up to whole
minutes. Standard runners are free for public repositories; Larger runners are billed
even in public repositories. Self-hosted infrastructure costs are excluded.

Unknown hardware, missing permissions or unavailable repository visibility produce
unknown prices (null in JSON), never an assumed standard rate. A partial report shows
the known subtotal and unpriced jobs. Current pool definitions cannot prove historical
specifications. Included minutes, discounts, storage and historical price changes are
not modelled, so these are estimates, not invoices.

Use --rate SKU=PRICE to override a machine price, for example --rate linux_8_core=0.022.
OS=PRICE remains supported and deliberately applies to every machine of that OS.

Collection reads jobs and usage per run, repository visibility and hosted runner
definitions, including enterprise pools inherited through organization runner groups.
Reading pools and groups requires organization administration or runner/runner-group
read permissions, not enterprise-wide management access. Completed jobs and usage are cached.
Keep --max-runs in mind; --input uses captured inventory without new API requests.`,
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

			rows, warnings := metricspkg.BuildCostStats(data, priceList)
			data.Warnings = append(data.Warnings, warnings...)

			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsCost(r, rows); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.TruncatedRepos(), data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)
	cmd.Flags().StringArrayVar(&rates, "rate", nil, "Override a per-minute USD price as SKU=PRICE or OS=PRICE (default: automatic SKU pricing)")

	return cmd
}
