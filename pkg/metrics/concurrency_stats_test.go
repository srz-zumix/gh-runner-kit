package metrics

import (
	"testing"
	"time"
)

func TestConcurrencyTimeline(t *testing.T) {
	intervals := []Interval{
		{at(0), at(20)},
		{at(10), at(30)},
		{at(45), at(50)},
	}

	got, err := ConcurrencyTimeline(intervals, Window{Start: at(0), End: at(60)}, 15*time.Minute)
	if err != nil {
		t.Fatalf("ConcurrencyTimeline() error = %v", err)
	}

	want := []Bucket{
		{Start: at(0), End: at(15), Jobs: 2, Peak: 2, Busy: 20 * time.Minute},
		{Start: at(15), End: at(30), Jobs: 2, Peak: 2, Busy: 20 * time.Minute},
		{Start: at(30), End: at(45), Jobs: 0, Peak: 0, Busy: 0},
		{Start: at(45), End: at(60), Jobs: 1, Peak: 1, Busy: 5 * time.Minute},
	}

	if len(got) != len(want) {
		t.Fatalf("len(ConcurrencyTimeline()) = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("bucket %d = %+v, want %+v", i, got[i], want[i])
		}
	}
}

func TestConcurrencyTimelineTruncatesLastBucket(t *testing.T) {
	got, err := ConcurrencyTimeline(nil, Window{Start: at(0), End: at(50)}, 20*time.Minute)
	if err != nil {
		t.Fatalf("ConcurrencyTimeline() error = %v", err)
	}

	if len(got) != 3 {
		t.Fatalf("len(ConcurrencyTimeline()) = %d, want 3", len(got))
	}
	if last := got[2]; last.End != at(50) || last.Duration() != 10*time.Minute {
		t.Fatalf("last bucket = %+v, want it cut off at the end of the window", last)
	}
}

func TestConcurrencyTimelineRejectsNonPositiveSize(t *testing.T) {
	got, err := ConcurrencyTimeline(nil, Window{Start: at(0), End: at(60)}, 0)
	if err != nil {
		t.Fatalf("ConcurrencyTimeline(size=0) error = %v, want nil", err)
	}
	if got != nil {
		t.Fatalf("ConcurrencyTimeline(size=0) = %v, want nil", got)
	}
}

func TestConcurrencyTimelineRejectsTooManyBuckets(t *testing.T) {
	// A 1ns bucket over an hour would need 3.6e12 buckets, well past MaxBuckets.
	_, err := ConcurrencyTimeline(nil, Window{Start: at(0), End: at(60)}, time.Nanosecond)
	if err == nil {
		t.Fatal("ConcurrencyTimeline() with a tiny bucket did not return an error")
	}
}

func TestBucketCount(t *testing.T) {
	hour := Window{Start: at(0), End: at(60)}
	tests := []struct {
		name string
		w    Window
		size time.Duration
		want int64
	}{
		{"exact division", hour, 15 * time.Minute, 4},
		{"partial final bucket", Window{Start: at(0), End: at(50)}, 20 * time.Minute, 3},
		{"size equal to window", hour, time.Hour, 1},
		{"size larger than window", hour, 2 * time.Hour, 1},
		{"non-positive size", hour, 0, 0},
		{"empty window", Window{Start: at(0), End: at(0)}, time.Minute, 0},
	}
	for _, tt := range tests {
		if got := BucketCount(tt.w, tt.size); got != tt.want {
			t.Errorf("%s: BucketCount() = %d, want %d", tt.name, got, tt.want)
		}
	}
}

func TestValidateBucketWindow(t *testing.T) {
	hour := Window{Start: at(0), End: at(60)}

	// A width that yields exactly MaxBuckets is accepted; one bucket more is rejected.
	exact := hour.Duration() / time.Duration(MaxBuckets)
	if err := ValidateBucketWindow(hour, exact); err != nil {
		t.Fatalf("ValidateBucketWindow(exactly MaxBuckets) error = %v, want nil", err)
	}
	if got := BucketCount(hour, exact); got != MaxBuckets {
		t.Fatalf("BucketCount(exact) = %d, want %d", got, MaxBuckets)
	}

	tooSmall := exact - 1
	if err := ValidateBucketWindow(hour, tooSmall); err == nil {
		t.Fatalf("ValidateBucketWindow(MaxBuckets+ buckets) error = nil, want an error (count=%d)", BucketCount(hour, tooSmall))
	}

	// A non-positive width produces a zero count, which the count guard accepts.
	if err := ValidateBucketWindow(hour, 0); err != nil {
		t.Fatalf("ValidateBucketWindow(size=0) error = %v, want nil", err)
	}
}

func TestBuildConcurrencyStats(t *testing.T) {
	rows, err := BuildConcurrencyStats(testData(), 30*time.Minute, nil)
	if err != nil {
		t.Fatalf("BuildConcurrencyStats() error = %v", err)
	}

	if len(rows) != 2 {
		t.Fatalf("len(BuildConcurrencyStats()) = %d, want 2", len(rows))
	}

	// build [5,15), lint [10,20) and test [20,30) all fall into the first bucket.
	first := rows[0]
	if got, want := first.Jobs, 3; got != want {
		t.Fatalf("Jobs = %d, want %d", got, want)
	}
	if got, want := first.Peak, 2; got != want {
		t.Fatalf("Peak = %d, want %d", got, want)
	}
	if got, want := first.BusyTime, 30*time.Minute; got != want {
		t.Fatalf("BusyTime = %v, want %v", got, want)
	}
	if got, want := first.Runners, 3; got != want {
		t.Fatalf("Runners = %d, want %d", got, want)
	}
	if got, want := first.Utilization, 1.0/3.0; got != want {
		t.Fatalf("Utilization = %v, want %v", got, want)
	}

	if got, want := rows[1].Jobs, 0; got != want {
		t.Fatalf("second bucket Jobs = %d, want %d", got, want)
	}
}

func TestBuildConcurrencyStatsFiltersByLabel(t *testing.T) {
	rows, err := BuildConcurrencyStats(testData(), time.Hour, []string{"cordoned"})
	if err != nil {
		t.Fatalf("BuildConcurrencyStats() error = %v", err)
	}

	if len(rows) != 1 {
		t.Fatalf("len(BuildConcurrencyStats()) = %d, want 1", len(rows))
	}
	if got, want := rows[0].Jobs, 0; got != want {
		t.Fatalf("Jobs = %d, want %d (no job requested the label)", got, want)
	}
	if got, want := rows[0].Runners, 1; got != want {
		t.Fatalf("Runners = %d, want %d (only the runners carrying the label count)", got, want)
	}
}
