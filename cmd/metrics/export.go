package metrics

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/cmdflags"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewExportCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var exportFormat string
	var summary bool

	cmd := &cobra.Command{
		Use:   "export",
		Short: "Publish the fleet metrics for monitoring",
		Long: `Publish the fleet overview and the per label breakdown in a machine readable form.

The default output is a Prometheus text exposition, which a scheduled workflow can push
to a Pushgateway or write to a file a collector picks up. Durations are exported in
seconds and ratios in the 0..1 range.

--summary additionally appends a Markdown report to the file named by the
GITHUB_STEP_SUMMARY environment variable, so the same run both publishes the metrics and
shows them on the workflow summary page. It is an error to ask for it outside of GitHub
Actions, where that variable is not set.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			summaryPath, err := kitutil.ResolveMetricsStepSummary(summary)
			if err != nil {
				return err
			}

			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}
			// The machine-readable output stays on stdout, so collection warnings go to
			// stderr instead of being silently dropped like the other reports avoid.
			kitutil.WarnMetricsWarnings(data.Warnings)
			report := metricspkg.BuildExportReport(data)

			r := render.NewRenderer(flags.Exporter)
			if r.HasExporter() {
				if err := r.RenderExportedData(report); err != nil {
					return err
				}
			} else if err := kitutil.WriteMetricsPrometheus(r.IO.Out, report); err != nil {
				return fmt.Errorf("failed to write the Prometheus exposition: %w", err)
			}

			if summary {
				if err := kitutil.WriteMetricsStepSummary(summaryPath, report); err != nil {
					return err
				}
			}
			return nil
		},
	}

	flags.Add(cmd)
	// The setup can only fail when the format flag is missing, which flags.Add registers.
	cobra.CheckErr(cmdflags.SetupFormatFlagWithNonJSONFormats(cmd, &flags.Exporter, &exportFormat, "prometheus", []string{"prometheus"}))
	cmd.Flags().BoolVar(&summary, "summary", false, "Also append a Markdown report to $"+kitutil.MetricsStepSummaryEnv)

	return cmd
}
