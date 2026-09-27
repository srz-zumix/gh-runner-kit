package metrics

import (
	"fmt"
	"strings"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewReportCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var sectionNames []string
	var groupBy string
	var bucket string
	var labels []string
	var selfHostedOnly bool
	var includeUnused bool
	var targetWait string
	var targetUtilization float64
	var rates []string

	cmd := &cobra.Command{
		Use:   "report",
		Short: "Print every metrics report from a single collection",
		Long: fmt.Sprintf(`Collect the fleet once and print several of the other metrics reports from it,
which is cheaper than running each of them on its own when API rate limits are a
concern.

Pass --section one or more times to pick which reports to print, or leave it unset to
get every section except cost, which needs one extra billable-usage request per run.
Accepted sections: %s.

--group-by, --bucket, --label, --self-hosted-only, --include-unused, --target-wait,
--target-utilization and --rate configure their matching section the same way its own
metrics command does; --label only narrows the concurrency section, no other section
accepts a label filter.`, strings.Join(kitutil.ReportSectionNames(), ", ")),
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			sections, err := kitutil.ParseReportSections(sectionNames)
			if err != nil {
				return err
			}

			_, width, err := flags.ResolveConcurrency(bucket)
			if err != nil {
				return err
			}

			wait, err := flags.ResolveCapacity(targetWait, targetUtilization)
			if err != nil {
				return err
			}

			priceList, err := metricspkg.ParseRates(rates)
			if err != nil {
				return err
			}

			wantUsage := false
			for _, s := range sections {
				if s == kitutil.ReportSectionCost {
					wantUsage = true
				}
			}

			data, err := flags.CollectReport(cmd, wantUsage)
			if err != nil {
				return err
			}

			opts := kitutil.ReportOptions{
				GroupBy:           metricspkg.Grouping(groupBy),
				Bucket:            width,
				Labels:            labels,
				SelfHostedOnly:    selfHostedOnly,
				IncludeUnused:     includeUnused,
				TargetWait:        wait,
				TargetUtilization: targetUtilization,
				Rates:             priceList,
			}

			report, err := kitutil.BuildMetricsReport(data, sections, opts)
			if err != nil {
				return err
			}

			r := render.NewRenderer(flags.Exporter)
			return kitutil.RenderMetricsReport(r, report, sections)
		},
	}

	flags.Add(cmd)
	f := cmd.Flags()
	f.StringArrayVar(&sectionNames, "section", nil, "Print only this section (repeatable, default every section except cost)")
	cmdutil.StringEnumFlag(cmd, &groupBy, "group-by", "", string(metricspkg.GroupByName), metricspkg.Groupings, "Aggregate the runner section by this key")
	f.StringVar(&bucket, "bucket", "1h", "Width of each concurrency timeline bucket, such as 15m")
	f.StringArrayVar(&labels, "label", nil, "Keep only the concurrency section jobs whose runs-on set carries this label (repeatable)")
	f.BoolVar(&selfHostedOnly, "self-hosted-only", false, "Exclude the workflow section jobs that ran on GitHub-hosted runners")
	f.BoolVar(&includeUnused, "include-unused", false, "List the label section's labels no job requested in the window")
	f.StringVar(&targetWait, "target-wait", metricspkg.DefaultTargetWait.String(), "Mean queue time the capacity section aims for, such as 60s")
	f.Float64Var(&targetUtilization, "target-utilization", metricspkg.DefaultTargetUtilization, "Highest share of the time a runner may be busy in the capacity section, greater than 0 and at most 1")
	f.StringArrayVar(&rates, "rate", nil, "Override the per-minute price of an operating system in the cost section, as OS=PRICE such as ubuntu=0.008")

	return cmd
}
