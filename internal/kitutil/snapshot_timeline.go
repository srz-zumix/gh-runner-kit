package kitutil

import (
	"fmt"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

// ReadSnapshotRunTimeline resolves the reference only against retained data.
func ReadSnapshotRunTimeline(input, run, repo string, attempt int, opts metrics.TimelineOptions) (metrics.RunTimeline, error) {
	ref, err := metrics.ParseRunRef(run)
	if err != nil {
		return metrics.RunTimeline{}, err
	}
	if attempt < 0 {
		return metrics.RunTimeline{}, fmt.Errorf("attempt must not be negative")
	}
	if attempt > 0 {
		if ref.Attempt > 0 && ref.Attempt != attempt {
			return metrics.RunTimeline{}, fmt.Errorf("attempt conflicts with the attempt in the run URL")
		}
		ref.Attempt = attempt
	}
	if repo != "" {
		parsed, err := repository.Parse(repo)
		if err != nil {
			return metrics.RunTimeline{}, err
		}
		if ref.Repo != nil && (ref.Repo.Host != parsed.Host || ref.Repo.Owner != parsed.Owner || ref.Repo.Name != parsed.Name) {
			return metrics.RunTimeline{}, fmt.Errorf("run URL conflicts with the requested repository")
		}
		ref.Repo = &parsed
	}
	snapshot, err := metrics.ReadSnapshot(input)
	if err != nil {
		return metrics.RunTimeline{}, fmt.Errorf("failed to read the timeline snapshot: %w", err)
	}
	opts.JobID = ref.JobID
	return metrics.BuildSnapshotTimeline(snapshot, ref, opts)
}
