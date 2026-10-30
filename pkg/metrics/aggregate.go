package metrics

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/google/go-github/v93/github"
)

// JobKind classifies the runner that executed a workflow job.
type JobKind string

const (
	JobKindSelfHosted JobKind = "self-hosted"
	JobKindHosted     JobKind = "hosted"
	JobKindUnknown    JobKind = "unknown"
)

// selfHostedLabel is implicitly assigned to every self-hosted runner.
const selfHostedLabel = "self-hosted"

// hostedRunnerGroup is the runner group GitHub reports for its own hosted runners.
const hostedRunnerGroup = "GitHub Actions"

// hostedLabelPrefixes are the label prefixes of GitHub-hosted runner images.
var hostedLabelPrefixes = []string{"ubuntu-", "windows-", "macos-"}

// Interval is a half-open time range [Start, End) during which a runner was busy.
type Interval struct {
	Start time.Time
	End   time.Time
}

// Duration returns the length of the interval, or 0 when it is not well formed.
func (i Interval) Duration() time.Duration {
	if !i.End.After(i.Start) {
		return 0
	}
	return i.End.Sub(i.Start)
}

// Percentile returns the nearest-rank percentile of values, where p is in [0, 100].
// values is left unmodified. The zero value is returned for an empty slice.
func Percentile[T cmp.Ordered](values []T, p float64) T {
	var zero T
	if len(values) == 0 {
		return zero
	}

	sorted := slices.Clone(values)
	slices.Sort(sorted)

	rank := int(math.Ceil(p / 100 * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// PeakConcurrency returns the highest number of intervals that overlap at any instant.
// An interval ending exactly when another starts does not count as an overlap.
func PeakConcurrency(intervals []Interval) int {
	type event struct {
		at    time.Time
		delta int
	}

	events := make([]event, 0, len(intervals)*2)
	for _, iv := range intervals {
		if iv.Duration() == 0 {
			continue
		}
		events = append(events, event{at: iv.Start, delta: 1}, event{at: iv.End, delta: -1})
	}

	// Releases are applied before acquisitions at the same instant.
	slices.SortFunc(events, func(a, b event) int {
		if c := a.at.Compare(b.at); c != 0 {
			return c
		}
		return a.delta - b.delta
	})

	peak, current := 0, 0
	for _, e := range events {
		current += e.delta
		if current > peak {
			peak = current
		}
	}
	return peak
}

// Bucket is one fixed-width slice of a concurrency timeline.
type Bucket struct {
	Start time.Time
	End   time.Time
	Jobs  int
	Peak  int
	Busy  time.Duration
}

// Duration returns the length of the bucket.
func (b Bucket) Duration() time.Duration {
	return b.End.Sub(b.Start)
}

// MaxBuckets caps how many buckets a single concurrency timeline may contain. It guards
// against pathological --bucket/window combinations, such as a 1ns bucket over a multi-day
// window, that would otherwise allocate and iterate an unbounded number of buckets and
// exhaust memory. The limit is generous enough for realistic reports, for example
// one-minute buckets over a month (43200 buckets).
const MaxBuckets = 100_000

// BucketCount reports how many buckets ConcurrencyTimeline emits for w at the given size,
// which is ceil(w.Duration()/size). It returns 0 when either input is non-positive. The
// result is kept as int64 so callers can compare it against MaxBuckets before any narrowing
// conversion, avoiding overflow on extreme inputs.
func BucketCount(w Window, size time.Duration) int64 {
	duration := w.Duration()
	if size <= 0 || duration <= 0 {
		return 0
	}
	count := int64(duration / size)
	if duration%size != 0 {
		count++
	}
	return count
}

// ValidateBucketWindow reports whether splitting w into buckets of the given width would
// exceed MaxBuckets. It only enforces the bucket-count limit; a non-positive width or
// window yields a zero count (see BucketCount) and is therefore accepted here, leaving
// that decision to the caller. It is the single source of the bucket-count guard shared
// by the concurrency timeline and the command layer.
func ValidateBucketWindow(w Window, width time.Duration) error {
	count := BucketCount(w, width)
	if count > MaxBuckets {
		return fmt.Errorf("the selected window needs %d buckets of %s, more than the limit of %d; use a larger bucket width", count, width, MaxBuckets)
	}
	return nil
}

// ConcurrencyTimeline splits w into buckets of the given width and reports, for each
// of them, how many intervals touched it, how many overlapped at its busiest instant
// and how much busy time they added up to. The last bucket is cut off at the end of
// the window so that its utilization is not diluted by time outside the window.
// It returns an error when the window would need more than MaxBuckets buckets, so a
// direct caller can never trigger an unbounded allocation.
func ConcurrencyTimeline(intervals []Interval, w Window, size time.Duration) ([]Bucket, error) {
	return ConcurrencyTimelineInTimeZone(intervals, w, size, "")
}

// ConcurrencyTimelineInTimeZone aligns buckets to local midnight when timeZone is
// set, without extending w. Subdaily buckets reset each calendar day; 24h means
// one whole calendar day, including daylight-saving transitions.
func ConcurrencyTimelineInTimeZone(intervals []Interval, w Window, size time.Duration, timeZone string) ([]Bucket, error) {
	buckets, err := concurrencyBuckets(w, size, timeZone)
	if err != nil {
		return nil, err
	}
	// clamped is reused because PeakConcurrency never retains it.
	var clamped []Interval
	for i := range buckets {
		bucket := &buckets[i]
		slice := Window{Start: bucket.Start, End: bucket.End}
		clamped = clamped[:0]
		for _, iv := range intervals {
			trimmed, ok := slice.Clamp(iv)
			if !ok {
				continue
			}
			clamped = append(clamped, trimmed)
			bucket.Jobs++
			bucket.Busy += trimmed.Duration()
		}
		bucket.Peak = PeakConcurrency(clamped)
	}
	return buckets, nil
}

// ValidateBucketWindowInTimeZone validates the zone, width and aligned bucket
// count before collection. An empty zone preserves window-start anchoring.
func ValidateBucketWindowInTimeZone(w Window, size time.Duration, timeZone string) error {
	if timeZone == "" {
		return ValidateBucketWindow(w, size)
	}
	_, err := concurrencyBuckets(w, size, timeZone)
	return err
}

func concurrencyBuckets(w Window, size time.Duration, timeZone string) ([]Bucket, error) {
	var location *time.Location
	if timeZone != "" {
		var err error
		location, err = time.LoadLocation(timeZone)
		if err != nil {
			return nil, fmt.Errorf("invalid --time-zone %q: %w", timeZone, err)
		}
		if size > 24*time.Hour {
			return nil, fmt.Errorf("--bucket must be at most 24h when --time-zone is set")
		}
	}
	if size <= 0 || w.Duration() <= 0 {
		return nil, nil
	}

	capacity := 0
	if location == nil {
		if err := ValidateBucketWindow(w, size); err != nil {
			return nil, err
		}
		capacity = int(BucketCount(w, size))
	}

	buckets := make([]Bucket, 0, capacity)
	for start := w.Start; start.Before(w.End); {
		if len(buckets) == MaxBuckets {
			return nil, fmt.Errorf("the selected window needs more than the limit of %d buckets of %s; use a larger bucket width", MaxBuckets, size)
		}
		end := start.Add(size)
		if location != nil {
			local := start.In(location)
			year, month, day := local.Date()
			midnight := time.Date(year, month, day, 0, 0, 0, 0, location)
			nextMidnight := time.Date(year, month, day+1, 0, 0, 0, 0, location)
			end = nextMidnight
			if size != 24*time.Hour {
				end = midnight.Add((start.Sub(midnight)/size + 1) * size)
				if end.After(nextMidnight) {
					end = nextMidnight
				}
			}
		}
		if end.After(w.End) {
			end = w.End
		}
		buckets = append(buckets, Bucket{Start: start, End: end})
		start = end
	}
	return buckets, nil
}

// Utilization returns busy divided by window, clamped to [0, 1].
// The denominator is the wall-clock length of the aggregation window, not the time
// the runner was online, because the API does not expose historical online state.
func Utilization(busy, window time.Duration) float64 {
	if window <= 0 || busy <= 0 {
		return 0
	}
	return min(float64(busy)/float64(window), 1)
}

// ClassifyJob determines whether a job ran on a self-hosted or a GitHub-hosted runner.
// selfHostedRunnerIDs holds the IDs of the self-hosted runners registered in the same
// scope as the job, which is the only fully reliable signal.
func ClassifyJob(job *github.WorkflowJob, selfHostedRunnerIDs map[int64]bool) JobKind {
	if job == nil {
		return JobKindUnknown
	}

	if id := job.GetRunnerID(); id != 0 && selfHostedRunnerIDs[id] {
		return JobKindSelfHosted
	}
	if strings.EqualFold(job.GetRunnerGroupName(), hostedRunnerGroup) {
		return JobKindHosted
	}
	if hasLabel(job.Labels, selfHostedLabel) {
		return JobKindSelfHosted
	}
	if hasHostedLabel(job.Labels) {
		return JobKindHosted
	}
	return JobKindUnknown
}

// MatchesRunner reports whether a runner carrying runnerLabels can pick up a job
// requesting jobLabels. GitHub requires the runner to carry every requested label
// and compares them case-insensitively.
func MatchesRunner(jobLabels, runnerLabels []string) bool {
	if len(jobLabels) == 0 {
		return false
	}
	for _, want := range jobLabels {
		if !hasLabel(runnerLabels, want) {
			return false
		}
	}
	return true
}

// NormalizeLabelSet lowercases and sorts labels so that a runs-on set can be used
// as a grouping key regardless of the order it was written in.
func NormalizeLabelSet(labels []string) []string {
	normalized := make([]string, 0, len(labels))
	for _, label := range labels {
		normalized = append(normalized, strings.ToLower(label))
	}
	slices.Sort(normalized)
	return slices.Compact(normalized)
}

// labelSetKey encodes a normalized label set without allowing separators inside a
// user-defined label to collide with the boundaries between labels.
func labelSetKey(labels []string) string {
	var b strings.Builder
	for _, label := range labels {
		fmt.Fprintf(&b, "%d:%s", len(label), label)
	}
	return b.String()
}

// formatLabelSet renders labels as a compact CSV-style list. Ordinary labels keep the
// existing comma-separated form, while labels containing separators are quoted so two
// distinct sets never produce the same displayed or exported value.
func formatLabelSet(labels []string) string {
	formatted := make([]string, len(labels))
	for i, label := range labels {
		if label == "" || strings.ContainsAny(label, ",\"\r\n") {
			label = `"` + strings.ReplaceAll(label, `"`, `""`) + `"`
		}
		formatted[i] = label
	}
	return strings.Join(formatted, ",")
}

func hasLabel(labels []string, want string) bool {
	return slices.ContainsFunc(labels, func(label string) bool {
		return strings.EqualFold(label, want)
	})
}

func hasHostedLabel(labels []string) bool {
	for _, label := range labels {
		lower := strings.ToLower(label)
		for _, prefix := range hostedLabelPrefixes {
			if strings.HasPrefix(lower, prefix) {
				return true
			}
		}
	}
	return false
}
