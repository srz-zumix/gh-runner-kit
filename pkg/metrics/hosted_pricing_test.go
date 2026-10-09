package metrics

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"testing"
	"time"

	"github.com/google/go-github/v90/github"
)

func hostedPool(name, platform, size string, cores, memory int) *github.HostedRunner {
	return &github.HostedRunner{
		ID: github.Ptr(int64(900)), Name: &name, Platform: &platform,
		RunnerGroupID:      github.Ptr(int64(2)),
		MachineSizeDetails: &github.HostedRunnerMachineSpec{ID: size, CPUCores: cores, MemoryGB: memory, StorageGB: 300},
	}
}

func TestHostedCatalogMatchesStandaloneCanvas(t *testing.T) {
	canvas, err := os.ReadFile("../../.github/extensions/actions-metrics/lib/hosted_prices.json")
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bytes.TrimSpace(canvas), bytes.TrimSpace(hostedPricesJSON)) {
		t.Fatal("the CLI and independently installable canvas must bundle identical price catalogs")
	}
}

func TestPriceHostedJob(t *testing.T) {
	tests := []struct {
		name, label, sku, platform, size string
		cores, memory                    int
		rate                             float64
	}{
		{name: "slim", label: "ubuntu-slim", sku: "actions_linux_slim", rate: 0.002},
		{name: "standard linux", label: "ubuntu-latest", sku: "actions_linux", rate: 0.006},
		{name: "standard arm", label: "ubuntu-24.04-arm", sku: "actions_linux_arm", rate: 0.005},
		{name: "standard windows", label: "windows-2025", sku: "actions_windows", rate: 0.010},
		{name: "standard windows arm", label: "windows-11-arm", sku: "actions_windows_arm", rate: 0.010},
		{name: "standard mac", label: "macos-15", sku: "actions_macos", rate: 0.062},
		{name: "mac large", label: "macos-15-large", sku: "macos_l", rate: 0.077},
		{name: "mac xlarge", label: "macos-26-xlarge", sku: "macos_xl", rate: 0.102},
		{name: "linux 8", label: "pool", platform: "linux-x64", size: "8-core", cores: 8, memory: 32, sku: "linux_8_core", rate: 0.022},
		{name: "linux 16 arm", label: "pool", platform: "linux-arm64", size: "16-core", cores: 16, memory: 64, sku: "linux_16_core_arm", rate: 0.026},
		{name: "windows 64 arm", label: "pool", platform: "win-arm64", size: "64-core-arm", cores: 64, memory: 208, sku: "windows_64_core_arm", rate: 0.194},
		{name: "linux gpu", label: "pool", platform: "linux-x64", size: "4-core-gpu", cores: 4, memory: 28, sku: "linux_4_core_gpu", rate: 0.052},
		{name: "windows gpu", label: "pool", platform: "win-x64", size: "4-core-gpu", cores: 4, memory: 28, sku: "windows_4_core_gpu", rate: 0.102},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			job := &github.WorkflowJob{Labels: []string{tt.label}, RunnerID: github.Ptr(int64(17))}
			var pools []*github.HostedRunner
			if tt.platform != "" {
				pools = []*github.HostedRunner{hostedPool("pool", tt.platform, tt.size, tt.cores, tt.memory)}
			}
			got := PriceHostedJob(job, pools, nil, github.Ptr(false), nil)
			if got.SKU != tt.sku || got.Rate == nil || *got.Rate != tt.rate {
				t.Fatalf("price = %+v, want %s at %g", got, tt.sku, tt.rate)
			}
			if tt.cores > 0 && (got.CPUCores != tt.cores || got.MemoryGB != tt.memory) {
				t.Fatalf("spec = %+v, want CPU %d / RAM %d", got, tt.cores, tt.memory)
			}
		})
	}
}

func TestHostedPricingDoesNotGuessUnknownMachines(t *testing.T) {
	pool := hostedPool("pool", "linux-x64", "8-core", 8, 32)
	tests := []struct {
		name   string
		job    *github.WorkflowJob
		pools  []*github.HostedRunner
		public *bool
	}{
		{"unknown custom label", &github.WorkflowJob{Labels: []string{"ubuntu-16core"}}, nil, github.Ptr(false)},
		{"instance ID is not pool ID", &github.WorkflowJob{Labels: []string{"build"}, RunnerID: pool.ID}, []*github.HostedRunner{pool}, github.Ptr(false)},
		{"group mismatch", &github.WorkflowJob{Labels: []string{"pool"}, RunnerGroupID: github.Ptr(int64(3))}, []*github.HostedRunner{pool}, github.Ptr(false)},
		{"ambiguous labels", &github.WorkflowJob{Labels: []string{"pool", "other"}}, []*github.HostedRunner{pool, hostedPool("other", "linux-x64", "16-core", 16, 64)}, github.Ptr(false)},
		{"unknown size", &github.WorkflowJob{Labels: []string{"pool"}}, []*github.HostedRunner{hostedPool("pool", "linux-x64", "custom", 8, 32)}, github.Ptr(false)},
		{"unknown architecture", &github.WorkflowJob{Labels: []string{"pool"}}, []*github.HostedRunner{hostedPool("pool", "linux-ppc64", "8-core", 8, 32)}, github.Ptr(false)},
		{"unknown platform variant", &github.WorkflowJob{Labels: []string{"pool"}}, []*github.HostedRunner{hostedPool("pool", "linux-arm64-gpu", "4-core", 4, 28)}, github.Ptr(false)},
		{"visibility unknown", &github.WorkflowJob{Labels: []string{"ubuntu-latest"}}, nil, nil},
		{"standard label in custom group", &github.WorkflowJob{Labels: []string{"ubuntu-latest"}, RunnerGroupName: github.Ptr("custom")}, nil, github.Ptr(false)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := PriceHostedJob(tt.job, tt.pools, nil, tt.public, nil)
			if p.Rate != nil || p.Excluded || p.Reason == "" {
				t.Fatalf("price = %+v, want an explicitly unknown price", p)
			}
		})
	}
}

func TestPublicStandardAndLargerPricing(t *testing.T) {
	public := github.Ptr(true)
	standard := PriceHostedJob(&github.WorkflowJob{Labels: []string{"ubuntu-latest"}}, nil, nil, public, nil)
	larger := PriceHostedJob(&github.WorkflowJob{Labels: []string{"macos-15-large"}}, nil, nil, public, nil)
	if standard.Rate == nil || *standard.Rate != 0 || standard.CPUCores != 4 || standard.MemoryGB != 16 {
		t.Fatalf("public standard = %+v", standard)
	}
	if larger.Rate == nil || *larger.Rate != 0.077 {
		t.Fatalf("public larger = %+v, want charged execution", larger)
	}
}

func TestHostedPriceOverridesAndSelfHostedExclusion(t *testing.T) {
	job := &github.WorkflowJob{Labels: []string{"pool"}}
	pools := []*github.HostedRunner{hostedPool("pool", "linux-x64", "8-core", 8, 32)}
	for _, rates := range []map[string]float64{{"LINUX_8_CORE": 0.123}, {"UBUNTU": 0.123}} {
		price := PriceHostedJob(job, pools, nil, github.Ptr(false), rates)
		if price.Rate == nil || *price.Rate != 0.123 {
			t.Fatalf("override = %+v", price)
		}
	}
	for _, job := range []*github.WorkflowJob{
		{Labels: []string{"self-hosted", "ubuntu-latest"}},
		{Labels: []string{"pool"}, RunnerID: github.Ptr(int64(9))},
	} {
		price := PriceHostedJob(job, pools, map[int64]bool{9: true}, github.Ptr(false), nil)
		if !price.Excluded {
			t.Fatalf("self-hosted job was priced: %+v", price)
		}
	}
}

func TestCostStatsMixedMachinesAndUnknownSubtotal(t *testing.T) {
	data := &Data{
		Runs:             []*github.WorkflowRun{runWithID(1)},
		RunRepositories:  map[int64]string{1: "octo/demo"},
		RepositoryPublic: map[string]bool{"octo/demo": false},
		HostedRunners:    map[string][]*github.HostedRunner{"octo": {hostedPool("pool", "linux-x64", "8-core", 8, 32)}},
		Usage:            map[int64]*github.WorkflowRunUsage{1: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": detailedBill(30_000, 61_000, 1_000)})},
	}
	for i, label := range []string{"ubuntu-latest", "pool", "ubuntu-16core"} {
		job := testJob(label, 0, "", []string{label}, "success", 0, 1, 2)
		job.ID = github.Ptr(int64(i + 1))
		data.Jobs = append(data.Jobs, job)
	}
	rows, warnings := BuildCostStats(data, nil)
	if len(rows) != 3 || len(warnings) != 1 {
		t.Fatalf("rows = %+v, warnings = %v", rows, warnings)
	}
	var known float64
	var unpriced int
	for _, row := range rows {
		known += row.KnownCost
		unpriced += row.UnpricedJobs
	}
	duration, cost := CostTotal(rows)
	if duration != 4*time.Minute || cost != nil || math.Abs(known-0.050) > 1e-9 || unpriced != 1 {
		t.Fatalf("total = %v / %v; known = %g, unpriced = %d", duration, cost, known, unpriced)
	}
	encoded, err := json.Marshal(rows)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(encoded, []byte(`"Cost":null`)) || !bytes.Contains(encoded, []byte(`"Rate":null`)) {
		t.Fatalf("unknown prices were not exported as null: %s", encoded)
	}
}
