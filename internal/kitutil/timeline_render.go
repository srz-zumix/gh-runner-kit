package kitutil

import (
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

// timelineJSON is the JSON wire shape of a RunTimeline. Its ids are quoted so that a
// consumer reading numbers as float64 does not round a run or job id past 2^53.
type timelineJSON struct {
	metrics.RunTimeline
	RunID int64             `json:"RunID,string"`
	Jobs  []timelineJobJSON `json:"Jobs"`
}

type timelineJobJSON struct {
	metrics.TimelineJob
	JobID int64                  `json:"JobID,string"`
	Steps []metrics.TimelineStep `json:"Steps"`
}

// RunTimelineJSON returns the JSON wire shape of tl, which --format json exports.
// Durations and offsets are integer nanoseconds.
func RunTimelineJSON(tl metrics.RunTimeline) any {
	out := timelineJSON{RunTimeline: tl, RunID: tl.RunID, Jobs: make([]timelineJobJSON, 0, len(tl.Jobs))}
	for _, job := range tl.Jobs {
		steps := job.Steps
		if steps == nil {
			steps = []metrics.TimelineStep{}
		}
		out.Jobs = append(out.Jobs, timelineJobJSON{TimelineJob: job, JobID: job.JobID, Steps: steps})
	}
	return out
}

// RenderRunTimeline prints a summary line for the run and then one line per job and per
// step, with offsets measured from the start of the run attempt.
func RenderRunTimeline(r *render.Renderer, tl metrics.RunTimeline, showWaiting bool) error {
	r.WriteLine(fmt.Sprintf("%s #%d (attempt %d): %s, %s",
		FormatOptional(tl.Workflow), tl.RunID, tl.RunAttempt, timelineOutcome(tl.Status, tl.Conclusion), FormatDuration(tl.Duration)))
	if tl.URL != "" {
		r.WriteLine(tl.URL)
	}
	r.WriteLine("")

	header := []string{"JOB", "STEP", "CONCLUSION", "OFFSET", "WAIT", "DURATION", "RUNNER"}
	if !showWaiting {
		header = []string{"JOB", "STEP", "CONCLUSION", "OFFSET", "DURATION", "RUNNER"}
	}
	t := r.NewTableWriter(header)
	for _, job := range tl.Jobs {
		row := []string{
			job.Name,
			"-",
			timelineOutcome(job.Status, job.Conclusion),
			formatTimelineOffset(job.StartedAt, job.StartedOffset),
			FormatDuration(job.Wait),
			FormatDuration(job.Duration),
			FormatOptional(job.RunnerName),
		}
		if !showWaiting {
			row = append(row[:4], row[5:]...)
		}
		t.Append(row)
		for _, step := range job.Steps {
			row := []string{
				job.Name,
				step.Key,
				timelineOutcome(step.Status, step.Conclusion),
				formatTimelineOffset(step.StartedAt, step.Offset),
				"",
				FormatDuration(step.Duration),
				"",
			}
			if !showWaiting {
				row = append(row[:4], row[5:]...)
			}
			t.Append(row)
		}
	}
	return t.Render()
}

// timelineOutcome is the conclusion of something that finished, or its status while it
// is still running.
func timelineOutcome(status, conclusion string) string {
	if conclusion != "" {
		return conclusion
	}
	return FormatOptional(status)
}

func formatTimelineOffset(at *time.Time, offset time.Duration) string {
	if at == nil {
		return "-"
	}
	return "+" + FormatMeasuredDuration(offset)
}

// WriteRunTimelineMermaid writes the timeline as a Mermaid Gantt chart in the style of
// Kesin11/actions-timeline: one section per job, an "active" bar for the time the job
// waited for a runner, and one bar per step, marked "crit" when it failed. The axis
// starts at 00:00:00, the start of the run attempt, so it does not depend on a time zone.
func WriteRunTimelineMermaid(w io.Writer, tl metrics.RunTimeline, showWaiting bool) error {
	var b strings.Builder
	b.WriteString("gantt\n")
	title := tl.Workflow
	if title == "" {
		title = "run " + strconv.FormatInt(tl.RunID, 10)
	}
	fmt.Fprintf(&b, "  title %s\n", mermaidText(title))
	b.WriteString("  dateFormat HH:mm:ss\n")
	b.WriteString("  axisFormat %H:%M:%S\n")

	for i, job := range tl.Jobs {
		fmt.Fprintf(&b, "  section %s\n", mermaidText(job.Name))
		task := 0
		bar := func(name, tags string, offset, duration time.Duration) {
			if tags != "" {
				tags += ", "
			}
			fmt.Fprintf(&b, "    %s (%s) :%sj%d-%d, %s, %s\n",
				mermaidText(name), FormatMeasuredDuration(duration), tags, i, task, mermaidClock(offset), mermaidDuration(duration))
			task++
		}
		if showWaiting && job.QueuedAt != nil && job.StartedAt != nil {
			bar("Waiting for a runner", "active", job.QueuedOffset, job.Wait)
		}
		drawn := false
		for _, step := range job.Steps {
			if step.StartedAt == nil {
				continue
			}
			bar(step.Key, mermaidTag(step.Conclusion), step.Offset, step.Duration)
			drawn = true
		}
		// A job that reports no step timings still shows how long it ran.
		if !drawn && job.StartedAt != nil {
			bar(job.Name, mermaidTag(job.Conclusion), job.StartedOffset, job.Duration)
		}
	}
	_, err := io.WriteString(w, b.String())
	return err
}

// mermaidTag marks a failed bar as critical and a bar that never really ran as done.
func mermaidTag(conclusion string) string {
	switch conclusion {
	case "failure", "timed_out", "startup_failure":
		return "crit"
	case "skipped", "cancelled":
		return "done"
	default:
		return ""
	}
}

// mermaidText makes a name safe for a Gantt task or section, where ":" separates the
// task metadata, ";" ends a statement and "#" starts an entity code.
func mermaidText(s string) string {
	return strings.NewReplacer(
		":", "\uA789",
		";", ",",
		"#", "\uFF03",
		"\r", " ",
		"\n", " ",
	).Replace(strings.TrimSpace(s))
}

// mermaidClock renders an offset from the start of the run as HH:mm:ss.
func mermaidClock(d time.Duration) string {
	s := int64(max(d, 0).Round(time.Second) / time.Second)
	return fmt.Sprintf("%02d:%02d:%02d", s/3600, s/60%60, s%60)
}

// mermaidDuration renders the length of a bar in whole seconds.
func mermaidDuration(d time.Duration) string {
	return strconv.FormatInt(int64(max(d, 0).Round(time.Second)/time.Second), 10) + "s"
}
