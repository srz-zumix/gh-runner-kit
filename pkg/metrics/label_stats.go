package metrics

import (
	"cmp"
	"slices"
	"time"
)

// LabelStatus tells whether the demand for a label and the supply of runners match.
type LabelStatus string

const (
	// LabelStatusOK is a label that jobs request and runners provide.
	LabelStatusOK LabelStatus = "ok"
	// LabelStatusOrphan is a label jobs request but no registered runner carries, so
	// jobs asking for it cannot start until a runner picks the label up.
	LabelStatusOrphan LabelStatus = "orphan"
	// LabelStatusUnused is a label runners carry but no job requested in the window.
	LabelStatusUnused LabelStatus = "unused"
)

// LabelRow is one line of the metrics label report. It covers a single label, unlike
// the queue report which groups by the whole runs-on set.
type LabelRow struct {
	Label     string
	Status    LabelStatus
	Jobs      int
	Runners   int
	WaitP50   time.Duration
	WaitP95   time.Duration
	LastJobAt time.Time
}

// BuildLabelStats matches the labels the fleet jobs requested against the labels the
// registered runners carry, so that a label which is requested but never served, or
// served but never requested, becomes visible. Runners reflects the inventory as it is
// now, because the API keeps no history of the labels a runner used to carry.
func BuildLabelStats(data *Data) []LabelRow {
	demand := map[string]*jobStats{}
	for _, job := range FleetJobs(NewJobs(data)) {
		for _, label := range NormalizeLabelSet(job.Labels) {
			s, ok := demand[label]
			if !ok {
				s = &jobStats{}
				demand[label] = s
			}
			s.add(job, data.Window)
		}
	}

	supply := map[string]int{}
	for _, runner := range data.Runners {
		labels := make([]string, 0, len(runner.Labels))
		for _, label := range runner.Labels {
			labels = append(labels, label.GetName())
		}
		for _, label := range NormalizeLabelSet(labels) {
			supply[label]++
		}
	}

	rows := make([]LabelRow, 0, len(demand)+len(supply))
	for label, s := range demand {
		rows = append(rows, LabelRow{
			Label:     label,
			Status:    labelStatus(s.count, supply[label]),
			Jobs:      s.count,
			Runners:   supply[label],
			WaitP50:   Percentile(s.waits, 50),
			WaitP95:   Percentile(s.waits, 95),
			LastJobAt: s.lastJobAt,
		})
	}
	for label, runners := range supply {
		if _, ok := demand[label]; ok {
			continue
		}
		rows = append(rows, LabelRow{
			Label:   label,
			Status:  labelStatus(0, runners),
			Runners: runners,
		})
	}

	// Mismatches first, because surfacing them is what this report exists for.
	slices.SortFunc(rows, func(a, b LabelRow) int {
		if c := cmp.Compare(labelStatusRank(a.Status), labelStatusRank(b.Status)); c != 0 {
			return c
		}
		if c := cmp.Compare(b.Jobs, a.Jobs); c != 0 {
			return c
		}
		return cmp.Compare(a.Label, b.Label)
	})
	return rows
}

func labelStatus(jobs, runners int) LabelStatus {
	switch {
	case jobs > 0 && runners == 0:
		return LabelStatusOrphan
	case jobs == 0 && runners > 0:
		return LabelStatusUnused
	default:
		return LabelStatusOK
	}
}

func labelStatusRank(s LabelStatus) int {
	switch s {
	case LabelStatusOrphan:
		return 0
	case LabelStatusUnused:
		return 1
	default:
		return 2
	}
}
