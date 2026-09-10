package metrics

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewLabelCmd() *cobra.Command {
	var flags kitutil.MetricsFlags
	var includeUnused bool

	cmd := &cobra.Command{
		Use:   "label",
		Short: "Compare the demand for each label against the runners that carry it",
		Long: `Match the labels the jobs requested against the labels the registered runners carry,
one label at a time.

STATUS is orphan when jobs asked for the label but no runner carries it, so those jobs
cannot start until a runner picks the label up. Orphan rows are listed first.

Labels no job requested in the window are left out, because a large fleet carries many
of them. Pass --include-unused to list them as unused, which usually points at a typo
or at a label that outlived its workflow.

RUNNERS is the current inventory, because the API keeps no history of the labels a
runner used to carry. Jobs that ran on GitHub-hosted runners are excluded.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsLabels(r, metricspkg.BuildLabelStats(data, includeUnused)); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.Truncated, data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)
	cmd.Flags().BoolVar(&includeUnused, "include-unused", false, "List the labels no job requested in the window")

	return cmd
}
