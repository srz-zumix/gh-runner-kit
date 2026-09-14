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
		{name: "no override keeps the defaults", want: DefaultRates},
		{
			name:      "an override is matched case-insensitively",
			overrides: []string{"ubuntu=0.016"},
			want:      map[string]float64{"UBUNTU": 0.016, "WINDOWS": 0.016, "MACOS": 0.08},
		},
		{
			name:      "an unknown OS is added",
			overrides: []string{"UBUNTU_4_CORE=0.032"},
			want:      map[string]float64{"UBUNTU": 0.008, "WINDOWS": 0.016, "MACOS": 0.08, "UBUNTU_4_CORE": 0.032},
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
	if got, want := DefaultRates["UBUNTU"], 0.008; got != want {
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

	// MACOS costs one minute at 0.08 and UBUNTU five rounded job-minutes at 0.008,
	// so macOS leads.
	if got, want := rows[0].OS, "MACOS"; got != want {
		t.Fatalf("rows[0].OS = %q, want %q", got, want)
	}
	if got, want := rows[0].Cost, 0.08; got != want {
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
	if got, want := cost, 0.12; got < want-1e-9 || got > want+1e-9 {
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

func TestBuildCostStatsUsesZeroForUnknownOS(t *testing.T) {
	data := &Data{
		Usage: map[int64]*github.WorkflowRunUsage{
			1: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU_64_CORE": detailedBill(60_000)}),
		},
	}

	rows, warnings := BuildCostStats(data, DefaultRates)
	if len(rows) != 1 {
		t.Fatalf("len(BuildCostStats()) = %d, want 1", len(rows))
	}
	if rows[0].Rate != 0 || rows[0].Cost != 0 {
		t.Fatalf("rows[0] = %+v, want a zero rate and cost for an OS without a price", rows[0])
	}
	// A billable OS without a known rate is estimated at $0, which must be warned about
	// rather than silently understating the total.
	if len(warnings) != 1 {
		t.Fatalf("BuildCostStats() warnings = %v, want one for the unpriced OS", warnings)
	}
}
