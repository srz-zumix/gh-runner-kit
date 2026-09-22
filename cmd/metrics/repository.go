package metrics

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewRepositoryCmd() *cobra.Command {
	var flags kitutil.MetricsFlags

	cmd := &cobra.Command{
		Use:   "repository",
		Short: "Show the per-repository workflow summary",
		Long: `Summarize the collected workflow activity by repository.

This report keeps the same collection semantics as the other metrics commands, but
rolls the workflow rows up to the repository level so that a single repository can
be compared against the others in an organization-wide report. The totals are built
from the normalized job records, so counts stay consistent with the per-workflow view.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			data, err := flags.Collect(cmd)
			if err != nil {
				return err
			}

			rows := metricspkg.BuildRepositoryStats(data)
			r := render.NewRenderer(flags.Exporter)
			if err := kitutil.RenderMetricsRepositories(r, rows); err != nil {
				return err
			}
			kitutil.WriteMetricsFooter(r, data.Window, len(data.Runs), data.TruncatedRepos(), data.Warnings)
			return nil
		},
	}

	flags.Add(cmd)
	return cmd
}
