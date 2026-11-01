package metrics

import (
	"reflect"
	"strings"
	"testing"
	"time"
)

func zoneInstant(t *testing.T, value string) time.Time {
	t.Helper()
	instant, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatal(err)
	}
	return instant
}

func TestConcurrencyTimeZoneMidnightAndClipping(t *testing.T) {
	window := Window{
		Start: zoneInstant(t, "2026-10-27T13:30:00Z"),
		End:   zoneInstant(t, "2026-10-29T01:15:00Z"),
	}
	intervals := []Interval{
		{window.Start.Add(-time.Hour), window.End.Add(time.Hour)},
		{window.Start.Add(-time.Hour), window.Start},
		{window.End, window.End.Add(time.Hour)},
	}
	for _, tt := range []struct {
		zone string
		ends []string
	}{
		{"Asia/Tokyo", []string{"2026-10-27T15:00:00Z", "2026-10-28T15:00:00Z", "2026-10-29T01:15:00Z"}},
		{"UTC", []string{"2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", "2026-10-29T01:15:00Z"}},
	} {
		t.Run(tt.zone, func(t *testing.T) {
			buckets, err := ConcurrencyTimelineInTimeZone(intervals, window, 24*time.Hour, tt.zone)
			if err != nil {
				t.Fatal(err)
			}
			if len(buckets) != len(tt.ends) {
				t.Fatalf("got %d buckets, want %d", len(buckets), len(tt.ends))
			}
			start := window.Start
			var total time.Duration
			for i, bucket := range buckets {
				end := zoneInstant(t, tt.ends[i])
				if !bucket.Start.Equal(start) || !bucket.End.Equal(end) ||
					bucket.Jobs != 1 || bucket.Peak != 1 || bucket.Busy != end.Sub(start) {
					t.Fatalf("bucket %d = %+v, want [%s, %s) with one busy job", i, bucket, start, end)
				}
				total += bucket.Busy
				start = end
			}
			if total != window.Duration() {
				t.Fatalf("busy time = %s, want exact window %s", total, window.Duration())
			}
		})
	}
}

func TestConcurrencyTimeZoneDST(t *testing.T) {
	for _, tt := range []struct {
		name       string
		start, end string
		hours      int
	}{
		{"spring", "2026-03-07T00:00:00-05:00", "2026-03-10T00:00:00-04:00", 23},
		{"fall", "2026-10-31T00:00:00-04:00", "2026-11-03T00:00:00-05:00", 25},
	} {
		for _, size := range []time.Duration{24 * time.Hour, 10 * time.Hour} {
			t.Run(tt.name+"/"+size.String(), func(t *testing.T) {
				window := Window{Start: zoneInstant(t, tt.start), End: zoneInstant(t, tt.end)}
				location, err := time.LoadLocation("America/New_York")
				if err != nil {
					t.Fatal(err)
				}
				buckets, err := ConcurrencyTimelineInTimeZone([]Interval{{window.Start, window.End}}, window, size, location.String())
				if err != nil {
					t.Fatal(err)
				}
				durations := []time.Duration{24 * time.Hour, time.Duration(tt.hours) * time.Hour, 24 * time.Hour}
				if size < 24*time.Hour {
					durations = []time.Duration{
						10 * time.Hour, 10 * time.Hour, 4 * time.Hour,
						10 * time.Hour, 10 * time.Hour, time.Duration(tt.hours-20) * time.Hour,
						10 * time.Hour, 10 * time.Hour, 4 * time.Hour,
					}
				}
				if len(buckets) != len(durations) {
					t.Fatalf("got %d buckets, want %d", len(buckets), len(durations))
				}
				start := window.Start
				for i, bucket := range buckets {
					if !bucket.Start.Equal(start) || bucket.Duration() != durations[i] || bucket.Busy != durations[i] {
						t.Fatalf("bucket %d = %+v, want start %s and duration %s", i, bucket, start, durations[i])
					}
					if size == 24*time.Hour || i%3 == 2 {
						if end := bucket.End.In(location); end.Hour() != 0 || end.Minute() != 0 {
							t.Fatalf("daily reset is not midnight: %s", end)
						}
					}
					start = bucket.End
				}
				if !start.Equal(window.End) {
					t.Fatalf("last end = %s, want %s", start, window.End)
				}
			})
		}
	}
}

func TestConcurrencyTimeZoneValidation(t *testing.T) {
	start := zoneInstant(t, "2026-01-01T00:00:00Z")
	window := Window{Start: start, End: start.Add(24 * time.Hour)}
	width := window.Duration() / MaxBuckets
	if err := ValidateBucketWindowInTimeZone(window, width, "UTC"); err != nil {
		t.Fatalf("exactly MaxBuckets: %v", err)
	}
	partial := Window{Start: window.Start.Add(time.Millisecond), End: window.End.Add(time.Millisecond)}
	if BucketCount(partial, width) != MaxBuckets {
		t.Fatal("fixture must pass the unaligned bucket-count limit")
	}
	for _, tt := range []struct {
		name, zone string
		window     Window
		width      time.Duration
		message    string
	}{
		{"invalid zone", "Invalid/Example", window, time.Hour, "invalid --time-zone"},
		{"invalid zone with empty window", "Invalid/Example", Window{}, time.Hour, "invalid --time-zone"},
		{"oversized bucket", "UTC", window, 25 * time.Hour, "at most 24h"},
		{"tiny bucket", "Asia/Tokyo", window, time.Nanosecond, "limit"},
		{"alignment adds partial bucket", "UTC", partial, width, "limit"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateBucketWindowInTimeZone(tt.window, tt.width, tt.zone)
			if err == nil || !strings.Contains(err.Error(), tt.message) {
				t.Fatalf("validation error = %v, want %q", err, tt.message)
			}
			_, err = ConcurrencyTimelineInTimeZone(nil, tt.window, tt.width, tt.zone)
			if err == nil || !strings.Contains(err.Error(), tt.message) {
				t.Fatalf("timeline error = %v, want %q", err, tt.message)
			}
		})
	}
}

func TestConcurrencyTimeZoneBackwardsCompatibility(t *testing.T) {
	window := Window{Start: at(7), End: at(53)}
	intervals := []Interval{{at(0), at(60)}}
	for _, size := range []time.Duration{0, time.Hour, 25 * time.Hour, 15 * time.Minute} {
		got, err := ConcurrencyTimelineInTimeZone(intervals, window, size, "")
		want, oldErr := ConcurrencyTimeline(intervals, window, size)
		if err != nil || oldErr != nil || !reflect.DeepEqual(got, want) {
			t.Fatalf("size %s: got %+v, %v; want %+v, %v", size, got, err, want, oldErr)
		}
		if size > 0 && !got[0].Start.Equal(window.Start) {
			t.Fatalf("size %s: first bucket start changed", size)
		}
	}
	data := testData()
	data.Window = window
	got, err := BuildConcurrencyStatsInTimeZone(data, 15*time.Minute, nil, "")
	want, oldErr := BuildConcurrencyStats(data, 15*time.Minute, nil)
	if err != nil || oldErr != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("stats changed: got %+v, %v; want %+v, %v", got, err, want, oldErr)
	}
}

func TestConcurrencyTimeZoneFiltersAndUtilization(t *testing.T) {
	data := testData()
	data.Window = Window{Start: at(7), End: at(25)}
	rows, err := BuildConcurrencyStatsInTimeZone(data, 15*time.Minute, []string{"LINUX"}, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	for i, want := range []struct {
		jobs int
		busy time.Duration
		util float64
	}{
		{2, 13 * time.Minute, 13.0 / 24},
		{2, 10 * time.Minute, 1.0 / 3},
	} {
		if row := rows[i]; row.Jobs != want.jobs || row.Runners != 3 ||
			row.BusyTime != want.busy || row.Utilization != want.util {
			t.Fatalf("row %d = %+v, want %+v with 3 runners", i, row, want)
		}
	}
	rows, err = BuildConcurrencyStatsInTimeZone(data, 15*time.Minute, []string{"cordoned"}, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if row.Jobs != 0 || row.Runners != 1 || row.BusyTime != 0 || row.Utilization != 0 {
			t.Fatalf("label-filtered row = %+v, want one eligible runner and no jobs", row)
		}
	}
}

func TestConcurrencyTimeZoneSkippedMidnight(t *testing.T) {
	// America/Santiago skips 2026-09-06 00:00 (clocks jump to 01:00).
	window := Window{Start: zoneInstant(t, "2026-09-05T00:00:00-04:00"), End: zoneInstant(t, "2026-09-07T00:00:00-03:00")}
	for _, size := range []time.Duration{24 * time.Hour, 6 * time.Hour} {
		t.Run(size.String(), func(t *testing.T) {
			buckets, err := ConcurrencyTimelineInTimeZone([]Interval{{window.Start, window.End}}, window, size, "America/Santiago")
			if err != nil {
				t.Fatal(err)
			}
			start := window.Start
			for i, bucket := range buckets {
				if !bucket.Start.Equal(start) || !bucket.End.After(bucket.Start) {
					t.Fatalf("bucket %d = %+v does not advance from %s", i, bucket, start)
				}
				start = bucket.End
			}
			if !start.Equal(window.End) {
				t.Fatalf("last end = %s, want %s", start, window.End)
			}
			if size == 24*time.Hour && (len(buckets) != 2 || buckets[1].Duration() != 23*time.Hour) {
				t.Fatalf("got %+v, want 24h and 23h days", buckets)
			}
		})
	}
}
