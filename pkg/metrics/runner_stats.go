package metrics

import (
	"cmp"
	"slices"
	"strings"
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
	stats := map[string]*jobStats{}
	kinds := map[string]JobKind{}

	if groupBy == GroupByName {
		for _, runner := range data.Runners {
			name := runner.GetName()
			stats[name] = &jobStats{}
			kinds[name] = JobKindSelfHosted
		}
	}

	for _, job := range FleetJobs(NewJobs(data)) {
		key := runnerRowKey(job, groupBy)
		if _, ok := stats[key]; !ok {
			stats[key] = &jobStats{}
			kinds[key] = job.Kind
		}
		stats[key].add(job, data.Window)
	}

	runners := indexRunnersByName(data)
	window := data.Window.Duration()

	rows := make([]RunnerRow, 0, len(stats))
	for key, s := range stats {
		row := RunnerRow{
			Key:         key,
			Kind:        kinds[key],
			Jobs:        s.count,
			BusyTime:    s.busy,
			FailureRate: s.failureRate(),
			WaitP50:     Percentile(s.waits, 50),
			DurationP50: Percentile(s.durations, 50),
			DurationP95: Percentile(s.durations, 95),
			LastJobAt:   s.lastJobAt,
			Utilization: Utilization(s.busy, window),
		}

		if runner, ok := runners[key]; ok {
			row.Status = runner.GetStatus()
			row.Cordoned = runnerpkg.IsCordoned(runner)
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

func runnerRowKey(job Job, groupBy Grouping) string {
	var key string
	switch groupBy {
	case GroupByLabel:
		key = strings.Join(NormalizeLabelSet(job.Labels), ",")
	case GroupByGroup:
		key = job.RunnerGroup
	default:
		key = job.RunnerName
	}

	if key == "" {
		return unknownKey
	}
	return key
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
