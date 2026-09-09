package metrics

import (
	"reflect"
	"testing"
	"time"

	"github.com/google/go-github/v90/github"
)

func at(minute int) time.Time {
	return time.Date(2026, 9, 1, 0, minute, 0, 0, time.UTC)
}

func TestPercentile(t *testing.T) {
	cases := []struct {
		name   string
		values []int
		p      float64
		want   int
	}{
		{"empty", nil, 50, 0},
		{"single", []int{7}, 95, 7},
		{"p50 of ten", []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, 50, 5},
		{"p95 of ten", []int{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}, 95, 10},
		{"p0 clamps to first", []int{3, 1, 2}, 0, 1},
		{"p100 is max", []int{3, 1, 2}, 100, 3},
		{"unsorted input", []int{9, 1, 5, 3, 7}, 50, 5},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Percentile(tc.values, tc.p); got != tc.want {
				t.Fatalf("Percentile(%v, %v) = %v, want %v", tc.values, tc.p, got, tc.want)
			}
		})
	}
}

func TestPercentileDoesNotMutateInput(t *testing.T) {
	values := []int{5, 1, 3}
	Percentile(values, 50)
	if want := []int{5, 1, 3}; !reflect.DeepEqual(values, want) {
		t.Fatalf("input mutated: got %v, want %v", values, want)
	}
}

func TestPeakConcurrency(t *testing.T) {
	cases := []struct {
		name      string
		intervals []Interval
		want      int
	}{
		{"empty", nil, 0},
		{"single", []Interval{{at(0), at(10)}}, 1},
		{
			name:      "adjacent intervals do not overlap",
			intervals: []Interval{{at(0), at(10)}, {at(10), at(20)}},
			want:      1,
		},
		{
			name:      "two overlapping",
			intervals: []Interval{{at(0), at(10)}, {at(5), at(15)}},
			want:      2,
		},
		{
			name:      "peak in the middle",
			intervals: []Interval{{at(0), at(30)}, {at(5), at(15)}, {at(10), at(12)}, {at(20), at(25)}},
			want:      3,
		},
		{
			name:      "zero length intervals are ignored",
			intervals: []Interval{{at(0), at(0)}, {at(5), at(1)}, {at(0), at(10)}},
			want:      1,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := PeakConcurrency(tc.intervals); got != tc.want {
				t.Fatalf("PeakConcurrency() = %d, want %d", got, tc.want)
			}
		})
	}
}

func TestUtilization(t *testing.T) {
	cases := []struct {
		name   string
		busy   time.Duration
		window time.Duration
		want   float64
	}{
		{"zero window", time.Hour, 0, 0},
		{"negative busy", -time.Hour, time.Hour, 0},
		{"half", 30 * time.Minute, time.Hour, 0.5},
		{"clamped to one", 2 * time.Hour, time.Hour, 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Utilization(tc.busy, tc.window); got != tc.want {
				t.Fatalf("Utilization(%v, %v) = %v, want %v", tc.busy, tc.window, got, tc.want)
			}
		})
	}
}

func TestClassifyJob(t *testing.T) {
	selfHosted := map[int64]bool{42: true}

	cases := []struct {
		name string
		job  *github.WorkflowJob
		want JobKind
	}{
		{"nil job", nil, JobKindUnknown},
		{
			name: "runner id matches a registered self-hosted runner",
			job:  &github.WorkflowJob{RunnerID: github.Ptr(int64(42)), Labels: []string{"ubuntu-latest"}},
			want: JobKindSelfHosted,
		},
		{
			name: "github hosted runner group",
			job:  &github.WorkflowJob{RunnerID: github.Ptr(int64(7)), RunnerGroupName: github.Ptr("GitHub Actions"), Labels: []string{"ubuntu-latest"}},
			want: JobKindHosted,
		},
		{
			name: "self-hosted label on an unknown runner id",
			job:  &github.WorkflowJob{RunnerID: github.Ptr(int64(99)), Labels: []string{"self-hosted", "linux"}},
			want: JobKindSelfHosted,
		},
		{
			name: "self-hosted label wins over a hosted image label",
			job:  &github.WorkflowJob{Labels: []string{"self-hosted", "ubuntu-22.04"}},
			want: JobKindSelfHosted,
		},
		{
			name: "hosted image label",
			job:  &github.WorkflowJob{Labels: []string{"macos-14"}},
			want: JobKindHosted,
		},
		{
			name: "custom label only",
			job:  &github.WorkflowJob{Labels: []string{"gpu"}},
			want: JobKindUnknown,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClassifyJob(tc.job, selfHosted); got != tc.want {
				t.Fatalf("ClassifyJob() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMatchesRunner(t *testing.T) {
	cases := []struct {
		name         string
		jobLabels    []string
		runnerLabels []string
		want         bool
	}{
		{"no requested labels", nil, []string{"self-hosted"}, false},
		{"exact match", []string{"linux"}, []string{"self-hosted", "linux"}, true},
		{"case insensitive", []string{"Linux", "X64"}, []string{"self-hosted", "linux", "x64"}, true},
		{"missing one label", []string{"linux", "gpu"}, []string{"self-hosted", "linux"}, false},
		{"runner has extra labels", []string{"gpu"}, []string{"self-hosted", "linux", "gpu"}, true},
		{"runner has no labels", []string{"linux"}, nil, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := MatchesRunner(tc.jobLabels, tc.runnerLabels); got != tc.want {
				t.Fatalf("MatchesRunner(%v, %v) = %v, want %v", tc.jobLabels, tc.runnerLabels, got, tc.want)
			}
		})
	}
}

func TestNormalizeLabelSet(t *testing.T) {
	cases := []struct {
		name   string
		labels []string
		want   []string
	}{
		{"empty", nil, []string{}},
		{"sorted and lowered", []string{"Linux", "self-hosted"}, []string{"linux", "self-hosted"}},
		{"order independent", []string{"self-hosted", "linux"}, []string{"linux", "self-hosted"}},
		{"duplicates removed", []string{"linux", "Linux"}, []string{"linux"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NormalizeLabelSet(tc.labels); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("NormalizeLabelSet(%v) = %v, want %v", tc.labels, got, tc.want)
			}
		})
	}
}
