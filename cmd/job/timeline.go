package job

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/cmdflags"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

// Output formats of the run timeline.
const (
	timelineFormatMermaid = "mermaid"
	timelineFormatTable   = "table"
)

// NewTimelineCmd creates the job timeline command.
func NewTimelineCmd() *cobra.Command {
	var repoFlag string
	var attempt int
	var opts metricspkg.TimelineOptions
	var showWaiting bool
	var noCache bool
	var refresh bool
	var input string
	var exporter cmdutil.Exporter
	format := timelineFormatTable

	cmd := &cobra.Command{
		Use:   "timeline <RUN>",
		Short: "Show when every job and step of a workflow run ran",
		Long: `Show when every job and step of one workflow run attempt ran, on a time axis that
starts when the attempt started.

RUN is a run ID or the URL of a run, of one of its attempts or of one of its jobs, such
as https://github.com/OWNER/REPO/actions/runs/RUN_ID/attempts/2. A run ID takes the
repository from --repo or the current directory. A job URL keeps only that job and,
unless --attempt is given, shows the attempt the job belongs to.

The default table lists every job with its runner wait and duration, followed by its
steps, with OFFSET measured from the start of the attempt. --format mermaid writes a
Mermaid Gantt chart in the style of Kesin11/actions-timeline, with one section per job,
a bar for the time it waited for a runner and one bar per step, which renders directly
in a GitHub Markdown file or a job summary. --format json writes the whole timeline
with durations in nanoseconds and the run and job IDs quoted.

--attempt selects an earlier attempt than the latest one. Only the jobs of that attempt
are shown. --job keeps the jobs whose name matches the pattern, where * stands for any
sequence of characters. --show-waiting=false hides the runner wait.

The jobs of a completed attempt are cached on disk, like the metrics subcommands do.
--input reads the run and attempt from a metrics snapshot without API requests.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := opts.Validate(); err != nil {
				return err
			}
			var tl metricspkg.RunTimeline
			var err error
			if input != "" {
				tl, err = kitutil.ReadSnapshotRunTimeline(input, args[0], repoFlag, attempt, opts)
			} else {
				repo, ref, resolveErr := kitutil.ResolveRunTarget(args[0], repoFlag, attempt)
				if resolveErr != nil {
					return resolveErr
				}
				opts.JobID = ref.JobID
				tl, err = kitutil.FetchRunTimeline(cmd.Context(), repo, ref, opts, noCache, refresh)
			}
			if err != nil {
				return err
			}

			if len(tl.Jobs) == 0 {
				logger.Warn("no job matched", "run_id", tl.RunID, "attempt", tl.RunAttempt)
			}

			r := render.NewRenderer(exporter)
			if r.HasExporter() {
				return r.RenderExportedData(kitutil.RunTimelineJSON(tl))
			}
			if format == timelineFormatMermaid {
				if err := kitutil.WriteRunTimelineMermaid(r.IO.Out, tl, showWaiting); err != nil {
					return fmt.Errorf("failed to write the Mermaid timeline of run %d: %w", tl.RunID, err)
				}
				return nil
			}
			if err := kitutil.RenderRunTimeline(r, tl, showWaiting); err != nil {
				return fmt.Errorf("failed to render the timeline of run %d: %w", tl.RunID, err)
			}
			return nil
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.IntVar(&attempt, "attempt", 0, "Show this attempt of the run instead of the latest one")
	f.StringArrayVar(&opts.Jobs, "job", nil, "Keep only the jobs whose name matches this pattern, which accepts a * wildcard (repeatable)")
	f.BoolVar(&showWaiting, "show-waiting", true, "Show how long every job waited for a runner")
	f.BoolVar(&noCache, "no-cache", false, "Do not read or write the cached jobs of the run")
	f.BoolVar(&refresh, "refresh", false, "Ignore the cached jobs of the run and fetch them again")
	f.StringVar(&input, "input", "", "Read the run and attempt from a metrics snapshot without API requests")
	cmd.MarkFlagsMutuallyExclusive("input", "no-cache")
	cmd.MarkFlagsMutuallyExclusive("input", "refresh")
	cmdutil.AddFormatFlags(cmd, &exporter)
	// The setup can only fail when the format flag is missing, which AddFormatFlags registers.
	cobra.CheckErr(cmdflags.SetupFormatFlagWithNonJSONFormats(cmd, &exporter, &format, timelineFormatTable, []string{timelineFormatMermaid, timelineFormatTable}))

	return cmd
}
