package metrics

import (
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
				"UBUNTU": bill(60_000, 2),
				"MACOS":  bill(60_000, 1),
			}),
			2: usageOf(map[string]*github.WorkflowRunBill{
				"UBUNTU": bill(120_000, 3),
			}),
			// A run without billable usage, such as a fully self-hosted one.
			3: usageOf(map[string]*github.WorkflowRunBill{}),
			4: nil,
		},
	}

	rows := BuildCostStats(data, DefaultRates)
	if len(rows) != 2 {
		t.Fatalf("len(BuildCostStats()) = %d, want 2", len(rows))
	}

	// MACOS costs one minute at 0.08 and UBUNTU three minutes at 0.008, so macOS leads.
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
	if got, want := ubuntu.Billable, 3*time.Minute; got != want {
		t.Fatalf("UBUNTU Billable = %v, want %v", got, want)
	}

	billable, cost := CostTotal(rows)
	if got, want := billable, 4*time.Minute; got != want {
		t.Fatalf("CostTotal() billable = %v, want %v", got, want)
	}
	if got, want := cost, 0.104; got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("CostTotal() cost = %v, want %v", got, want)
	}
}

func TestBuildCostStatsUsesZeroForUnknownOS(t *testing.T) {
	data := &Data{
		Usage: map[int64]*github.WorkflowRunUsage{
			1: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU_64_CORE": bill(60_000, 1)}),
		},
	}

	rows := BuildCostStats(data, DefaultRates)
	if len(rows) != 1 {
		t.Fatalf("len(BuildCostStats()) = %d, want 1", len(rows))
	}
	if rows[0].Rate != 0 || rows[0].Cost != 0 {
		t.Fatalf("rows[0] = %+v, want a zero rate and cost for an OS without a price", rows[0])
	}
}
