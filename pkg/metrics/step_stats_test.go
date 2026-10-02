package metrics

import (
	"testing"
	"time"

	"github.com/google/go-github/v90/github"
)

func findStat(t *testing.T, stats []StepStat, job, step string) StepStat {
	t.Helper()
	for _, s := range stats {
		if s.JobName == job && s.StepKey == step {
			return s
		}
	}
	t.Fatalf("no statistic for %s/%s in %+v", job, step, stats)
	return StepStat{}
}

func TestBuildStepStats(t *testing.T) {
	stats := BuildStepStats(stepData(), StepRowOptions{}, StepStatOptions{})

	var order []string
	for _, s := range stats {
		order = append(order, s.JobName+"/"+s.StepKey)
	}
	want := []string{
		"build/Set up job", "build/Run actions/checkout@v4", "build/Compile", "build/Upload", "build/Upload #2",
		"lint/Set up job", "lint/Lint",
	}
	if len(order) != len(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v", order, want)
		}
	}

	compile := findStat(t, stats, "build", "Compile")
	if compile.Jobs != 3 || compile.Executed != 3 || compile.Failed != 1 || compile.Samples != 3 {
		t.Errorf("compile counts = %+v", compile)
	}
	if compile.P50 != 30*time.Second || compile.P90 != 40*time.Second || compile.Max != 40*time.Second {
		t.Errorf("compile durations p50=%v p90=%v max=%v", compile.P50, compile.P90, compile.Max)
	}
	if compile.Offset != 5*time.Second {
		t.Errorf("compile offset = %v, want 5s", compile.Offset)
	}
	if compile.Share != 0.8 {
		t.Errorf("compile share = %v, want 0.8", compile.Share)
	}
	if got := compile.FailureRate(); got != 1.0/3 {
		t.Errorf("failure rate = %v", got)
	}

	upload := findStat(t, stats, "build", "Upload")
	if upload.Jobs != 3 || upload.Executed != 1 || upload.Skipped != 1 || upload.Samples != 1 {
		t.Errorf("upload counts = %+v", upload)
	}
	if got := upload.Presence(); got != 1.0/3 {
		t.Errorf("upload presence = %v, want 1/3", got)
	}
}

func TestBuildStepStatsStepFilterKeepsDenominator(t *testing.T) {
	stats := BuildStepStats(stepData(), StepRowOptions{Steps: []string{"Upload*"}}, StepStatOptions{})
	if len(stats) != 2 {
		t.Fatalf("got %d statistics, want 2: %+v", len(stats), stats)
	}
	for _, s := range stats {
		if s.Jobs != 3 {
			t.Errorf("%s counts %d jobs, want 3", s.StepKey, s.Jobs)
		}
	}
}

func TestBuildStepStatsLimit(t *testing.T) {
	stats := BuildStepStats(stepData(), StepRowOptions{JobRowOptions: JobRowOptions{Limit: 1}}, StepStatOptions{Limit: 2})
	if len(stats) != 2 {
		t.Fatalf("got %d statistics, want 2", len(stats))
	}
	// The row limit must not cut the aggregation short.
	if stats[0].Samples != 3 {
		t.Errorf("first statistic aggregated %d samples, want 3", stats[0].Samples)
	}
}

func matrixData() *Data {
	data := stepData()
	data.Jobs = []*github.WorkflowJob{
		testStepJob(1, 2, 1, "test (ubuntu, 1.22)", "success", 0, 10, testStep(1, "Test", "success", 0, 10)),
		testStepJob(2, 2, 1, "test (macos, 1.22)", "success", 0, 20, testStep(1, "Test", "success", 0, 20)),
		testStepJob(3, 2, 1, "solo (only)", "success", 0, 5, testStep(1, "Run", "success", 0, 5)),
	}
	return data
}

func TestBuildStepStatsMergeMatrix(t *testing.T) {
	separate := BuildStepStats(matrixData(), StepRowOptions{}, StepStatOptions{})
	if len(separate) != 3 {
		t.Fatalf("without merging got %d statistics, want 3", len(separate))
	}

	merged := BuildStepStats(matrixData(), StepRowOptions{}, StepStatOptions{MergeMatrix: true})
	if len(merged) != 2 {
		t.Fatalf("with merging got %d statistics, want 2: %+v", len(merged), merged)
	}
	test := findStat(t, merged, "test", "Test")
	if test.Variants != 2 || test.Jobs != 2 || test.Samples != 2 {
		t.Errorf("merged test = %+v", test)
	}
	// A lone parenthesised name has no sibling and keeps its name.
	solo := findStat(t, merged, "solo (only)", "Run")
	if solo.Variants != 1 {
		t.Errorf("solo variants = %d, want 1", solo.Variants)
	}
}

func TestMatrixBaseName(t *testing.T) {
	cases := []struct {
		name string
		base string
		ok   bool
	}{
		{"test (ubuntu, 1.22)", "test", true},
		{"test (a (b))", "test", true},
		{"test", "", false},
		{"test(a)", "", false},
		{"(a)", "", false},
		{"caller / test (x)", "caller / test", true},
	}
	for _, tc := range cases {
		base, ok := matrixBaseName(tc.name)
		if base != tc.base || ok != tc.ok {
			t.Errorf("matrixBaseName(%q) = %q, %v, want %q, %v", tc.name, base, ok, tc.base, tc.ok)
		}
	}
}
