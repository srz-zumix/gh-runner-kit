package metrics

import (
	"strings"
	"testing"
	"time"

	"github.com/google/go-github/v90/github"
)

func usageOf(bills map[string]*github.WorkflowRunBill) *github.WorkflowRunUsage {
	billable := github.WorkflowRunBillMap(bills)
	return &github.WorkflowRunUsage{Billable: &billable}
}

func bill(totalMS int64, jobs int) *github.WorkflowRunBill {
	return &github.WorkflowRunBill{TotalMS: &totalMS, Jobs: &jobs}
}

func detailedBill(durations ...int64) *github.WorkflowRunBill {
	var totalMS int64
	jobRuns := make([]*github.WorkflowRunJobRun, 0, len(durations))
	for i, duration := range durations {
		totalMS += duration
		jobRuns = append(jobRuns, &github.WorkflowRunJobRun{
			JobID:      github.Ptr(i + 1),
			DurationMS: github.Ptr(duration),
		})
	}
	jobs := len(jobRuns)
	return &github.WorkflowRunBill{TotalMS: &totalMS, Jobs: &jobs, JobRuns: jobRuns}
}

func TestParseRates(t *testing.T) {
	tests := []struct {
		name      string
		overrides []string
		want      map[string]float64
		wantErr   bool
	}{
		{name: "no override selects automatic pricing", want: map[string]float64{}},
		{
			name:      "an override is matched case-insensitively",
			overrides: []string{"ubuntu=0.016"},
			want:      map[string]float64{"UBUNTU": 0.016},
		},
		{
			name:      "an unknown OS is added",
			overrides: []string{"UBUNTU_4_CORE=0.032"},
			want:      map[string]float64{"UBUNTU_4_CORE": 0.032},
		},
		{name: "missing separator", overrides: []string{"ubuntu"}, wantErr: true},
		{name: "empty OS", overrides: []string{"=0.01"}, wantErr: true},
		{name: "non numeric price", overrides: []string{"ubuntu=free"}, wantErr: true},
		{name: "negative price", overrides: []string{"ubuntu=-1"}, wantErr: true},
		{name: "NaN price", overrides: []string{"ubuntu=NaN"}, wantErr: true},
		{name: "infinite price", overrides: []string{"ubuntu=+Inf"}, wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParseRates(tt.overrides)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ParseRates() error = %v, wantErr %v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if len(got) != len(tt.want) {
				t.Fatalf("len(ParseRates()) = %d, want %d", len(got), len(tt.want))
			}
			for os, want := range tt.want {
				if got[os] != want {
					t.Errorf("ParseRates()[%q] = %v, want %v", os, got[os], want)
				}
			}
		})
	}
}

func TestParseRatesDoesNotMutateDefaults(t *testing.T) {
	if _, err := ParseRates([]string{"ubuntu=1"}); err != nil {
		t.Fatalf("ParseRates() error = %v", err)
	}
	if got, want := DefaultRates["UBUNTU"], 0.006; got != want {
		t.Fatalf("DefaultRates[UBUNTU] = %v, want %v", got, want)
	}
}

func TestBuildCostStats(t *testing.T) {
	data := &Data{
		Usage: map[int64]*github.WorkflowRunUsage{
			1: usageOf(map[string]*github.WorkflowRunBill{
				"UBUNTU": detailedBill(30_000, 30_000),
				"MACOS":  detailedBill(60_000),
				"UNUSED": bill(0, 0),
			}),
			2: usageOf(map[string]*github.WorkflowRunBill{
				"UBUNTU":  detailedBill(40_000, 40_000, 40_000),
				"WINDOWS": detailedBill(0, 0, 0),
			}),
			// A run without billable usage, such as a fully self-hosted one.
			3: usageOf(map[string]*github.WorkflowRunBill{}),
			4: nil,
		},
	}

	rows, warnings := BuildCostStats(data, DefaultRates)
	if len(rows) != 3 {
		t.Fatalf("len(BuildCostStats()) = %d, want 3", len(rows))
	}
	if len(warnings) != 0 {
		t.Fatalf("BuildCostStats() warnings = %v, want none", warnings)
	}

	// Explicit OS overrides also work for usage-only legacy snapshots.
	if got, want := rows[0].OS, "MACOS"; got != want {
		t.Fatalf("rows[0].OS = %q, want %q", got, want)
	}
	if got, want := *rows[0].Cost, 0.062; got != want {
		t.Fatalf("rows[0].Cost = %v, want %v", got, want)
	}

	ubuntu := rows[1]
	if got, want := ubuntu.Runs, 2; got != want {
		t.Fatalf("UBUNTU Runs = %d, want %d", got, want)
	}
	if got, want := ubuntu.Jobs, 5; got != want {
		t.Fatalf("UBUNTU Jobs = %d, want %d", got, want)
	}
	if got, want := ubuntu.Billable, 5*time.Minute; got != want {
		t.Fatalf("UBUNTU Billable = %v, want %v", got, want)
	}

	var windows *CostRow
	for i := range rows {
		if rows[i].OS == "UNUSED" {
			t.Fatal("BuildCostStats() returned an unused zero-valued operating system")
		}
		if rows[i].OS == "WINDOWS" {
			windows = &rows[i]
		}
	}
	if windows == nil {
		t.Fatal("BuildCostStats() omitted an operating system with jobs and zero duration")
	}
	if windows.Runs != 1 || windows.Jobs != 3 || windows.Billable != 0 {
		t.Fatalf("WINDOWS row = %+v, want one run, three jobs, and zero billable duration", *windows)
	}

	billable, cost := CostTotal(rows)
	if got, want := billable, 6*time.Minute; got != want {
		t.Fatalf("CostTotal() billable = %v, want %v", got, want)
	}
	if got, want := *cost, 0.092; got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("CostTotal() cost = %v, want %v", got, want)
	}
}

func TestBuildCostStatsFallsBackWithoutPerJobDurations(t *testing.T) {
	data := &Data{
		Runs: []*github.WorkflowRun{runWithID(1)},
		Usage: map[int64]*github.WorkflowRunUsage{
			1: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": bill(20_000, 2)}),
		},
	}

	rows, warnings := BuildCostStats(data, DefaultRates)
	if len(rows) != 1 || rows[0].Billable != 20*time.Second {
		t.Fatalf("BuildCostStats() rows = %+v, want a 20-second aggregate fallback", rows)
	}
	if len(warnings) != 1 || !strings.Contains(warnings[0], "without per-job minute rounding") {
		t.Fatalf("BuildCostStats() warnings = %v, want an unrounded fallback warning", warnings)
	}
}

func TestBuildCostStatsWarnsWhenUsageIsPartial(t *testing.T) {
	data := &Data{
		Runs:  []*github.WorkflowRun{runWithID(1), runWithID(2)},
		Usage: map[int64]*github.WorkflowRunUsage{1: usageOf(map[string]*github.WorkflowRunBill{})},
	}

	_, warnings := BuildCostStats(data, DefaultRates)
	if len(warnings) != 1 || !strings.Contains(warnings[0], "usage was available for 1 of 2 workflow runs") {
		t.Fatalf("BuildCostStats() warnings = %v, want a partial-usage warning", warnings)
	}
}

func TestBuildCostStatsKeepsUnknownPricesNull(t *testing.T) {
	data := &Data{
		Usage: map[int64]*github.WorkflowRunUsage{
			1: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU_64_CORE": detailedBill(60_000)}),
		},
	}

	rows, warnings := BuildCostStats(data, DefaultRates)
	if len(rows) != 1 {
		t.Fatalf("len(BuildCostStats()) = %d, want 1", len(rows))
	}
	if rows[0].Rate != nil || rows[0].Cost != nil || rows[0].UnpricedJobs != 1 {
		t.Fatalf("rows[0] = %+v, want null pricing and one unpriced job", rows[0])
	}
	if len(warnings) != 1 {
		t.Fatalf("BuildCostStats() warnings = %v, want one for the unpriced OS", warnings)
	}
}

func TestCostStatsCancelledExecutionEvidence(t *testing.T) {
	cases := []struct {
		name          string
		runnerID      int64
		runnerName    string
		labels        []string
		steps         []*github.TaskStep
		usage         *github.WorkflowRunUsage
		skipped       bool
		wantExecution bool
		wantJobs      int
		wantMinutes   int
		wantUnknown   bool
	}{
		{name: "unassigned reusable workflow call"},
		{name: "requested labels alone", labels: []string{"ubuntu-latest"}},
		{name: "requested self-hosted labels alone", labels: []string{"self-hosted"}},
		{name: "skipped steps do not prove execution", steps: []*github.TaskStep{testStep(1, "Build", "skipped", 0, 1)}},
		{name: "missing step start does not prove execution", steps: []*github.TaskStep{{Conclusion: github.Ptr("cancelled")}}},
		{name: "nil steps do not prove execution", steps: []*github.TaskStep{nil}},
		{name: "skipped job stays excluded despite runner metadata", skipped: true, runnerID: 9, labels: []string{"ubuntu-latest"}},
		{name: "zero usage cannot reintroduce skipped jobs", skipped: true, usage: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": detailedBill(0)})},
		{name: "allocated runner ID", runnerID: 9, labels: []string{"ubuntu-latest"}, wantExecution: true, wantJobs: 1, wantMinutes: 2},
		{name: "allocated runner name", runnerName: "GitHub Actions", labels: []string{"ubuntu-latest"}, wantExecution: true, wantJobs: 1, wantMinutes: 2},
		{name: "started step without runner metadata", labels: []string{"ubuntu-latest"}, steps: []*github.TaskStep{testStep(1, "Build", "cancelled", 0, 1)}, wantExecution: true, wantJobs: 1, wantMinutes: 2},
		{name: "started unknown machine remains unknown", runnerID: 9, labels: []string{"custom"}, wantExecution: true, wantJobs: 1, wantMinutes: 2, wantUnknown: true},
		{name: "zero usage does not prove execution", usage: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": detailedBill(0)})},
		{name: "positive usage proves execution", labels: []string{"ubuntu-latest"}, usage: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": detailedBill(30_000)}), wantExecution: true, wantJobs: 1, wantMinutes: 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conclusion := "cancelled"
			if tc.skipped {
				conclusion = "skipped"
			}
			job := testJob("build", tc.runnerID, tc.runnerName, tc.labels, conclusion, 0, 0, 2)
			job.ID = github.Ptr(int64(1))
			job.Status = github.Ptr("completed")
			job.Steps = tc.steps
			run := runWithID(1)
			run.Status = github.Ptr("completed")
			data := &Data{
				Runs:             []*github.WorkflowRun{run},
				Jobs:             []*github.WorkflowJob{job},
				RunRepositories:  map[int64]string{1: "octo/demo"},
				RepositoryPublic: map[string]bool{"octo/demo": false},
				Usage:            map[int64]*github.WorkflowRunUsage{1: tc.usage},
			}
			jobRows := BuildJobRows(data, JobRowOptions{})
			if len(jobRows) != 1 || jobRows[0].ExecutionStarted != tc.wantExecution {
				t.Fatalf("job rows = %+v, want ExecutionStarted=%v", jobRows, tc.wantExecution)
			}
			rows, warnings := BuildCostStats(data, nil)
			if tc.wantJobs == 0 {
				if len(rows) != 0 || len(warnings) != 0 {
					t.Fatalf("unexecuted job produced rows=%+v, warnings=%v", rows, warnings)
				}
				return
			}
			if len(rows) != 1 || rows[0].Jobs != tc.wantJobs ||
				rows[0].Billable != time.Duration(tc.wantMinutes)*time.Minute {
				t.Fatalf("rows = %+v, want %d jobs and %d minutes", rows, tc.wantJobs, tc.wantMinutes)
			}
			if (rows[0].Cost == nil) != tc.wantUnknown {
				t.Fatalf("cost = %v, want unknown=%v", rows[0].Cost, tc.wantUnknown)
			}
		})
	}
}
