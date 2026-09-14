package metrics

import (
	"cmp"
	"slices"
	"time"

	"github.com/google/go-github/v90/github"
	runnerpkg "github.com/srz-zumix/gh-runner-kit/pkg/runner"
)

// Grouping selects the key the runner report aggregates jobs by.
type Grouping string

const (
	// GroupByName aggregates per runner name.
	GroupByName Grouping = "name"
	// GroupByLabel aggregates per runs-on label set.
	GroupByLabel Grouping = "label"
	// GroupByGroup aggregates per runner group.
	GroupByGroup Grouping = "group"
)

// Groupings lists the accepted --group-by values.
var Groupings = []string{string(GroupByName), string(GroupByLabel), string(GroupByGroup)}

// unknownKey labels the jobs whose grouping key the API did not report.
const unknownKey = "(unknown)"

// RunnerRow is one line of the metrics runner report.
type RunnerRow struct {
	Key         string
	Kind        JobKind
	Status      string
	Cordoned    bool
	Jobs        int
	BusyTime    time.Duration
	Utilization float64
	FailureRate float64
	WaitP50     time.Duration
	DurationP50 time.Duration
	DurationP95 time.Duration
	LastJobAt   time.Time
}

// BuildRunnerStats aggregates the fleet activity of data by the requested grouping.
// When grouping by name every registered runner gets a row, so that a runner which
// picked up no work at all is still visible.
func BuildRunnerStats(data *Data, groupBy Grouping) []RunnerRow {
	type bucket struct {
		display string
		kind    JobKind
		stats   jobStats
	}

	buckets := map[string]*bucket{}

	if groupBy == GroupByName {
		for _, runner := range data.Runners {
			name := runner.GetName()
			buckets[name] = &bucket{display: name, kind: JobKindSelfHosted}
		}
	}

	for _, job := range FleetJobs(NewJobs(data)) {
		key, display := runnerRowKeys(job, groupBy)
		b, ok := buckets[key]
		if !ok {
			b = &bucket{display: display, kind: job.Kind}
			buckets[key] = b
		}
		b.stats.add(job, data.Window)
	}

	runners := indexRunnersByName(data)
	window := data.Window.Duration()

	rows := make([]RunnerRow, 0, len(buckets))
	for _, b := range buckets {
		row := RunnerRow{
			Key:         b.display,
			Kind:        b.kind,
			Jobs:        b.stats.count,
			BusyTime:    b.stats.busy,
			FailureRate: b.stats.failureRate(),
			WaitP50:     Percentile(b.stats.waits, 50),
			DurationP50: Percentile(b.stats.durations, 50),
			DurationP95: Percentile(b.stats.durations, 95),
			LastJobAt:   b.stats.lastJobAt,
			Utilization: Utilization(b.stats.busy, window),
		}

		if groupBy == GroupByName {
			if runner, ok := runners[b.display]; ok {
				row.Status = runner.GetStatus()
				row.Cordoned = runnerpkg.IsCordoned(runner)
			}
		}
		rows = append(rows, row)
	}

	// Busiest first, then alphabetically so that the output is stable.
	slices.SortFunc(rows, func(a, b RunnerRow) int {
		if c := cmp.Compare(b.Jobs, a.Jobs); c != 0 {
			return c
		}
		return cmp.Compare(a.Key, b.Key)
	})
	return rows
}

func runnerRowKeys(job Job, groupBy Grouping) (string, string) {
	var display string
	switch groupBy {
	case GroupByLabel:
		labels := NormalizeLabelSet(job.Labels)
		if len(labels) == 0 || len(labels) == 1 && labels[0] == "" {
			return unknownKey, unknownKey
		}
		display = formatLabelSet(labels)
		return labelSetKey(labels), display
	case GroupByGroup:
		display = job.RunnerGroup
	default:
		display = job.RunnerName
	}

	if display == "" {
		return unknownKey, unknownKey
	}
	return display, display
}

// indexRunnersByName maps the registered runners by name so that rows can be enriched
// with the status the runner has right now.
func indexRunnersByName(data *Data) map[string]*github.Runner {
	runners := make(map[string]*github.Runner, len(data.Runners))
	for _, runner := range data.Runners {
		runners[runner.GetName()] = runner
	}
	return runners
}
