package metrics

import (
	"testing"
	"time"
)

func TestParseWindow(t *testing.T) {
	now := time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC)

	cases := []struct {
		name      string
		days      int
		since     string
		wantStart time.Time
		wantErr   bool
	}{
		{"seven days", 7, "", time.Date(2026, 8, 31, 12, 0, 0, 0, time.UTC), false},
		{"one day", 1, "", time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC), false},
		{"zero days", 0, "", time.Time{}, true},
		{"negative days", -1, "", time.Time{}, true},
		{"since date", 0, "2026-08-01", time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), false},
		{"since rfc3339", 0, "2026-08-01T09:30:00Z", time.Date(2026, 8, 1, 9, 30, 0, 0, time.UTC), false},
		{"since takes precedence over days", 30, "2026-08-01", time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC), false},
		{"since in the future", 0, "2027-01-01", time.Time{}, true},
		{"since unparsable", 0, "yesterday", time.Time{}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, err := ParseWindow(tc.days, tc.since, now)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ParseWindow() error = %v, wantErr %v", err, tc.wantErr)
			}
			if tc.wantErr {
				return
			}
			if !w.Start.Equal(tc.wantStart) {
				t.Fatalf("Start = %v, want %v", w.Start, tc.wantStart)
			}
			if !w.End.Equal(now) {
				t.Fatalf("End = %v, want %v", w.End, now)
			}
		})
	}
}

func TestWindowCreated(t *testing.T) {
	w, err := ParseWindow(7, "", time.Date(2026, 9, 7, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatalf("ParseWindow() error = %v", err)
	}
	if got, want := w.Created(), ">=2026-08-31"; got != want {
		t.Fatalf("Created() = %q, want %q", got, want)
	}
	if got, want := w.Duration(), 7*24*time.Hour; got != want {
		t.Fatalf("Duration() = %v, want %v", got, want)
	}
}

func TestWindowClamp(t *testing.T) {
	w := Window{Start: at(10), End: at(20)}

	cases := []struct {
		name   string
		in     Interval
		want   Interval
		wantOK bool
	}{
		{"inside", Interval{at(12), at(15)}, Interval{at(12), at(15)}, true},
		{"clipped on both sides", Interval{at(0), at(30)}, Interval{at(10), at(20)}, true},
		{"clipped at start", Interval{at(5), at(15)}, Interval{at(10), at(15)}, true},
		{"clipped at end", Interval{at(15), at(30)}, Interval{at(15), at(20)}, true},
		{"entirely before", Interval{at(0), at(5)}, Interval{}, false},
		{"entirely after", Interval{at(25), at(30)}, Interval{}, false},
		{"touching the start boundary", Interval{at(0), at(10)}, Interval{}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := w.Clamp(tc.in)
			if ok != tc.wantOK {
				t.Fatalf("Clamp() ok = %v, want %v", ok, tc.wantOK)
			}
			if ok && (!got.Start.Equal(tc.want.Start) || !got.End.Equal(tc.want.End)) {
				t.Fatalf("Clamp() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestWindowContains(t *testing.T) {
	w := Window{Start: at(10), End: at(20)}

	cases := []struct {
		name string
		t    time.Time
		want bool
	}{
		{"before", at(9), false},
		{"at start", at(10), true},
		{"inside", at(15), true},
		{"at end is excluded", at(20), false},
		{"after", at(21), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := w.Contains(tc.t); got != tc.want {
				t.Fatalf("Contains(%v) = %v, want %v", tc.t, got, tc.want)
			}
		})
	}
}
