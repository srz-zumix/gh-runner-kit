package metrics

import (
	"fmt"

	"github.com/spf13/cobra"
	metricspkg "github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

func NewSnapshotCmd() *cobra.Command {
	var input, output, since, until string
	cmd := &cobra.Command{
		Use:   "snapshot --input FILE",
		Short: "Inspect or filter a collected metrics snapshot without API requests",
		Long: `Read a metrics snapshot and print compact JSON metadata: its version, collection
time, scope, contents, inventory, latest-job coverage, warnings and run/job counts.
Raw runs, attempts, jobs and usage remain in the snapshot rather than in stdout.

--since and --until optionally select runs by creation time in a closed-open window
within the collected period. All attempts, jobs and usage of selected runs remain,
including jobs executed outside the narrower window. Omitted boundaries retain the
snapshot's original boundaries. Dates without timezones use UTC.

--output optionally writes the resulting full snapshot atomically to a file, gzip-
compressing names ending in .gz. It cannot be "-" because stdout always carries
metadata. No API requests are made and the input is unchanged unless --output
names the input file.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			metadata, err := metricspkg.PrepareSnapshot(input, output, since, until)
			if err != nil {
				return fmt.Errorf("failed to prepare the metrics snapshot: %w", err)
			}
			if err := metricspkg.WriteSnapshotMetadata(cmd.OutOrStdout(), metadata); err != nil {
				return fmt.Errorf("failed to write snapshot metadata: %w", err)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&input, "input", "", "Read this snapshot file, or - for uncompressed JSON on stdin (required)")
	cmd.Flags().StringVar(&output, "output", "", "Also write the full resulting snapshot to this file")
	cmd.Flags().StringVar(&since, "since", "", "Keep runs created at or after this YYYY-MM-DD or RFC3339 time (default: snapshot start)")
	cmd.Flags().StringVar(&until, "until", "", "Keep runs created before this YYYY-MM-DD or RFC3339 time (default: snapshot end)")
	_ = cmd.MarkFlagRequired("input")
	return cmd
}
