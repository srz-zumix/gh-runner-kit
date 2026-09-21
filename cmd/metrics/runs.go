package metrics

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/cmdflags"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

const (
	runsFormatJSON   = "json"
	runsFormatNDJSON = "ndjson"
	runsFormatTable  = "table"
)

// NewRunsCmd creates the metrics runs command.
func NewRunsCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	format := runsFormatJSON

	cmd := &cobra.Command{
		Use:   "runs",
		Short: "List the workflow runs behind the metrics, one row each",
		Long: `List every workflow run returned by the collection, one row each.

The listing uses the same run collection and cache as the other metrics commands. It
does not calculate a duration from UPDATED, because GitHub may update that timestamp
after the run finished. Use CREATED and STARTED as timestamps and calculate a duration
according to the consumer's needs. --format ndjson writes one row at a time.

Under --all-repos, --max-runs applies independently to each repository. The table footer
reports how many repositories were truncated; metrics export also publishes per-repository
coverage.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := flags.CollectRuns(cmd)
			if err != nil {
				return err
			}
			rows := metricspkg.BuildRunRows(data)

			r := render.NewRenderer(flags.Exporter)
			if r.HasExporter() {
				return r.RenderExportedData(rows)
			}
			if format == runsFormatTable {
				if err := kitutil.RenderMetricsRuns(r, rows); err != nil {
					return err
				}
				kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.TruncatedRepos(), data.Warnings)
				return nil
			}

			kitutil.WarnMetricsWarnings(data.Warnings)
			write := kitutil.WriteMetricsRunsJSON
			if format == runsFormatNDJSON {
				write = kitutil.WriteMetricsRunsNDJSON
			}
			if err := write(r.IO.Out, rows); err != nil {
				return fmt.Errorf("failed to write the run listing: %w", err)
			}
			return nil
		},
	}

	flags.Add(cmd)
	cobra.CheckErr(cmdflags.SetupFormatFlagWithNonJSONFormats(cmd, &flags.Exporter, &format, runsFormatJSON, []string{runsFormatNDJSON, runsFormatTable}))
	return cmd
}
