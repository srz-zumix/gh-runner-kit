package metrics

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/cmdflags"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

// Output formats of the job listing.
const (
	jobsFormatJSON   = "json"
	jobsFormatNDJSON = "ndjson"
	jobsFormatTable  = "table"
)

func NewJobsCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var opts metricspkg.JobRowOptions
	// The listing defaults to JSON, and an unchanged --format leaves the exporter unset,
	// so the format is tracked here rather than being inferred from the exporter.
	format := jobsFormatJSON

	cmd := &cobra.Command{
		Use:   "jobs",
		Short: "List the jobs behind the metrics, one row each",
		Long: `List every job the metrics were aggregated from, one row each, so a downstream tool
can group them on an axis this extension does not report.

The rows come from the same collection and the same local job cache the other metrics
subcommands use, so this issues no extra API request when it follows one of them over
the same window.

QUEUED, STARTED and COMPLETED are the timestamps GitHub recorded; WAIT is the time
between the first two and DURATION the time between the last two. A job that never
started has no STARTED, no COMPLETED and no DURATION.

Unlike the aggregated reports the listing keeps the jobs that were skipped and the jobs
that have not finished yet, so that it shows everything that was collected. Only the
check runs apps publish alongside the jobs are left out, because they are not jobs.

--kind self-hosted also keeps the jobs whose runner could not be identified, the same
way the other reports count them as fleet activity.

--runner selects the runner names to keep and --exclude-runner the ones to drop, the
latter winning when a name matches both.

GitHub names its own hosted runners after their runner ID, which would give every hosted
job a runner of its own. The ID is dropped from RUNNER, leaving every hosted job on
"GitHub Actions", and stays available as RunnerID.

The output is large: a busy organization produces hundreds of thousands of rows over the
default window. Prefer --format ndjson to consume it row by row, and narrow it with
--label, --runner, --exclude-runner or --limit.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := opts.Validate(); err != nil {
				return err
			}

			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}
			rows := metricspkg.BuildJobRows(data, opts)

			r := render.NewRenderer(flags.Exporter)
			if r.HasExporter() {
				return r.RenderExportedData(rows)
			}

			if format == jobsFormatTable {
				if err := kitutil.RenderMetricsJobs(r, rows); err != nil {
					return err
				}
				kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.TruncatedRepos(), data.Warnings)
				return nil
			}

			// The listing is the whole of stdout, so the collection warnings go to stderr
			// instead of being dropped.
			kitutil.WarnMetricsWarnings(data.Warnings)
			write := kitutil.WriteMetricsJobsJSON
			if format == jobsFormatNDJSON {
				write = kitutil.WriteMetricsJobsNDJSON
			}
			if err := write(r.IO.Out, rows); err != nil {
				return fmt.Errorf("failed to write the job listing: %w", err)
			}
			return nil
		},
	}

	flags.Add(cmd)
	// The setup can only fail when the format flag is missing, which flags.Add registers.
	cobra.CheckErr(cmdflags.SetupFormatFlagWithNonJSONFormats(cmd, &flags.Exporter, &format, jobsFormatJSON, []string{jobsFormatNDJSON, jobsFormatTable}))
	f := cmd.Flags()
	f.StringArrayVar(&opts.Labels, "label", nil, "Keep only the jobs requesting this label (repeatable)")
	f.StringArrayVar(&opts.Runners, "runner", nil, "Keep only the jobs that ran on this runner name, which accepts a * wildcard (repeatable)")
	f.StringArrayVar(&opts.ExcludeRunners, "exclude-runner", nil, "Drop the jobs that ran on this runner name, which accepts a * wildcard (repeatable)")
	cmdutil.StringEnumFlag(cmd, &opts.Kind, "kind", "", metricspkg.JobKindFilterAll, metricspkg.JobKindFilters, "Keep only the jobs of this runner kind")
	f.IntVar(&opts.Limit, "limit", 0, "Stop after this many rows (0 for no limit)")

	return cmd
}
