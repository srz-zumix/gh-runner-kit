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

// Output formats of the step listing.
const (
	stepsFormatJSON   = "json"
	stepsFormatNDJSON = "ndjson"
	stepsFormatTable  = "table"
)

// NewStepsCmd creates the metrics steps command.
func NewStepsCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var opts metricspkg.StepRowOptions
	var mergeMatrix bool
	format := stepsFormatTable

	cmd := &cobra.Command{
		Use:   "steps",
		Short: "Report how long each step of every job takes",
		Long: `Report how long each step of every job takes across the collected runs.

Unlike metrics jobs, the default output is an aggregated table rather than JSON: one
line per step of every job, keyed by workflow, job name and step. A step whose name
repeats inside the same job is suffixed with " #N", so the occurrences are not merged.
RUNS is how many jobs executed the step and PRESENCE how many of the selected jobs that
is, SKIPPED how many skipped it and FAILURE the share of the executed steps that failed.
DUR P50, DUR P90 and DUR MAX describe the step duration, SHARE is the median fraction of the job
duration the step took, and OFFSET the median time between the job start and the step
start. The lines of a job are ordered by OFFSET.

--format json and --format ndjson instead write the steps unaggregated, one row each,
with the identity of the job that ran them, so a downstream tool can build its own
statistics. --format ndjson writes one row at a time and quotes the run and job IDs.

The steps come from the same collection and the same local job cache as metrics jobs,
so this issues no extra API request when it follows another metrics subcommand over the
same window. GitHub only records step timestamps to the second, and lists the jobs of
the latest attempt of every run.

--job and --step keep the jobs and the steps whose name matches the pattern, where *
stands for any sequence of characters, including a slash. A step filter does not
change the PRESENCE denominator, which still counts every selected job.

--merge-matrix folds the variants of a matrix job, such as "test (ubuntu, 1.22)" and
"test (macos, 1.22)", into one job named "test", shown with the number of variants.
A job name is only folded when another job of the same workflow shares its prefix.
It only applies to the table.

--limit caps the rows written by --format json and --format ndjson, and the lines of
the table, which still aggregates every step. To bound the API requests rather than
the output, combine --workflow with --max-runs.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := opts.Validate(); err != nil {
				return err
			}

			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			r := render.NewRenderer(flags.Exporter)
			if r.HasExporter() {
				return r.RenderExportedData(metricspkg.BuildStepRows(data, opts))
			}

			if format == stepsFormatTable {
				stats := metricspkg.BuildStepStats(data, opts, metricspkg.StepStatOptions{
					MergeMatrix: mergeMatrix,
					Limit:       opts.Limit,
				})
				if err := kitutil.RenderMetricsStepStats(r, stats); err != nil {
					return fmt.Errorf("failed to render the step statistics: %w", err)
				}
				kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.TruncatedRepos(), data.Warnings)
				return nil
			}

			// The listing is the whole of stdout, so the collection warnings go to stderr
			// instead of being dropped.
			kitutil.WarnMetricsWarnings(data.Warnings)
			write := kitutil.WriteMetricsStepsJSON
			if format == stepsFormatNDJSON {
				write = kitutil.WriteMetricsStepsNDJSON
			}
			if err := write(r.IO.Out, metricspkg.BuildStepRows(data, opts)); err != nil {
				return fmt.Errorf("failed to write the step listing: %w", err)
			}
			return nil
		},
	}

	flags.Add(cmd)
	// The setup can only fail when the format flag is missing, which flags.Add registers.
	cobra.CheckErr(cmdflags.SetupFormatFlagWithNonJSONFormats(cmd, &flags.Exporter, &format, stepsFormatTable, []string{stepsFormatNDJSON, stepsFormatTable}))
	f := cmd.Flags()
	f.StringArrayVar(&opts.Labels, "label", nil, "Keep only the jobs requesting this label (repeatable)")
	f.StringArrayVar(&opts.Runners, "runner", nil, "Keep only the jobs that ran on this runner name, which accepts a * wildcard (repeatable)")
	f.StringArrayVar(&opts.ExcludeRunners, "exclude-runner", nil, "Drop the jobs that ran on this runner name, which accepts a * wildcard (repeatable)")
	cmdutil.StringEnumFlag(cmd, &opts.Kind, "kind", "", metricspkg.JobKindFilterAll, metricspkg.JobKindFilters, "Keep only the jobs of this runner kind")
	f.StringArrayVar(&opts.Jobs, "job", nil, "Keep only the jobs whose name matches this pattern, which accepts a * wildcard (repeatable)")
	f.StringArrayVar(&opts.Steps, "step", nil, "Keep only the steps whose name matches this pattern, which accepts a * wildcard (repeatable)")
	f.BoolVar(&mergeMatrix, "merge-matrix", false, "Fold the variants of a matrix job into one job in the table")
	f.IntVar(&opts.Limit, "limit", 0, "Stop after this many rows, or table lines (0 for no limit)")

	return cmd
}
