package metrics

import (
	"strings"
	"time"

	runnerpkg "github.com/srz-zumix/gh-runner-kit/pkg/runner"
)

// Summary is the fleet level overview rendered by the metrics summary command.
// Every job metric covers the jobs that did not run on a GitHub-hosted runner.
type Summary struct {
	Window          Window
	Repos           int
	Runners         int
	Online          int
	Busy            int
	Cordoned        int
	Runs            int
	Jobs            int
	HostedJobs      int
	WaitP50         time.Duration
	WaitP95         time.Duration
	DurationP50     time.Duration
	DurationP95     time.Duration
	BusyTime        time.Duration
	Utilization     float64
	FailureRate     float64
	PeakConcurrency int
	Truncated       bool
	Warnings        []string
}

// BuildSummary aggregates data into the fleet overview.
func BuildSummary(data *Data) Summary {
	summary := Summary{
		Window:    data.Window,
		Repos:     len(data.Repos),
		Runners:   len(data.Runners),
		Runs:      len(data.Runs),
		Truncated: data.Truncated,
		Warnings:  data.Warnings,
	}

	for _, runner := range data.Runners {
		if strings.EqualFold(runner.GetStatus(), "online") {
			summary.Online++
		}
		if runner.GetBusy() {
			summary.Busy++
		}
		if runnerpkg.IsCordoned(runner) {
			summary.Cordoned++
		}
	}

	all := NewJobs(data)
	fleet := FleetJobs(all)
	summary.HostedJobs = len(all) - len(fleet)
	summary.Jobs = len(fleet)

	var stats jobStats
	for _, job := range fleet {
		stats.add(job, data.Window)
	}

	summary.WaitP50 = Percentile(stats.waits, 50)
	summary.WaitP95 = Percentile(stats.waits, 95)
	summary.DurationP50 = Percentile(stats.durations, 50)
	summary.DurationP95 = Percentile(stats.durations, 95)
	summary.BusyTime = stats.busy
	summary.FailureRate = stats.failureRate()
	summary.PeakConcurrency = PeakConcurrency(stats.intervals)

	// The denominator is the whole fleet across the window, because the API keeps no
	// history of when each runner was actually online.
	summary.Utilization = Utilization(stats.busy, data.Window.Duration()*time.Duration(summary.Runners))

	return summary
}
