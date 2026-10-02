package kitutil

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/cli/cli/v2/pkg/iostreams"
	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func testTimeline() metrics.RunTimeline {
	origin := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	at := func(s int) *time.Time {
		t := origin.Add(time.Duration(s) * time.Second)
		return &t
	}
	return metrics.RunTimeline{
		Repo: "octo/app", RunID: 9007199254740993, RunAttempt: 1, Workflow: "CI: main",
		Status: "completed", Conclusion: "failure", StartedAt: at(0), CompletedAt: at(3700), Duration: 3700 * time.Second,
		Jobs: []metrics.TimelineJob{
			{
				JobID: 9007199254740995, Name: "build; #1", Status: "completed", Conclusion: "failure",
				QueuedAt: at(0), StartedAt: at(5), CompletedAt: at(3700), Wait: 5 * time.Second, Duration: 3695 * time.Second,
				StartedOffset: 5 * time.Second, RunnerName: "runner-a",
				Steps: []metrics.TimelineStep{
					{Number: 1, Name: "Set up job", Key: "Set up job", Conclusion: "success", StartedAt: at(5), CompletedAt: at(7), Duration: 2 * time.Second, Offset: 5 * time.Second},
					{Number: 2, Name: "Test", Key: "Test", Conclusion: "failure", StartedAt: at(7), CompletedAt: at(3700), Duration: 3693 * time.Second, Offset: 7 * time.Second, JobOffset: 2 * time.Second},
					{Number: 3, Name: "Skipped", Key: "Skipped", Conclusion: "skipped"},
				},
			},
			{
				JobID: 2, Name: "no steps", Status: "completed", Conclusion: "success",
				QueuedAt: at(0), StartedAt: at(1), CompletedAt: at(2), Wait: time.Second, Duration: time.Second, StartedOffset: time.Second,
			},
		},
	}
}

func TestWriteRunTimelineMermaid(t *testing.T) {
	var buf bytes.Buffer
	if err := WriteRunTimelineMermaid(&buf, testTimeline(), true); err != nil {
		t.Fatalf("WriteRunTimelineMermaid() error = %v", err)
	}
	out := buf.String()
	for _, want := range []string{
		"gantt\n",
		"  title CI\uA789 main\n",
		"  dateFormat HH:mm:ss\n",
		"  section build, \uFF031\n",
		"    Waiting for a runner (5s) :active, j0-0, 00:00:00, 5s\n",
		"    Set up job (2s) :j0-1, 00:00:05, 2s\n",
		"    Test (1h1m33s) :crit, j0-2, 00:00:07, 3693s\n",
		"    no steps (1s) :j1-1, 00:00:01, 1s\n",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("output does not contain %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "Skipped") {
		t.Errorf("a step that never started must not get a bar:\n%s", out)
	}

	buf.Reset()
	if err := WriteRunTimelineMermaid(&buf, testTimeline(), false); err != nil {
		t.Fatalf("WriteRunTimelineMermaid() error = %v", err)
	}
	if strings.Contains(buf.String(), "Waiting") {
		t.Errorf("--show-waiting=false must drop the waiting bars:\n%s", buf.String())
	}
}

func TestWriteRunTimelineJSONQuotesLargeIDs(t *testing.T) {
	data, err := json.MarshalIndent(RunTimelineJSON(testTimeline()), "", "  ")
	if err != nil {
		t.Fatalf("json.MarshalIndent() error = %v", err)
	}
	out := string(data)
	for _, want := range []string{`"RunID": "9007199254740993"`, `"JobID": "9007199254740995"`, `"Steps": []`} {
		if !strings.Contains(out, want) {
			t.Errorf("output does not contain %s:\n%s", want, out)
		}
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
}

func TestRenderRunTimeline(t *testing.T) {
	streams, _, stdout, _ := iostreams.Test()
	r := render.NewRenderer(nil)
	r.IO = streams
	if err := RenderRunTimeline(r, testTimeline(), true); err != nil {
		t.Fatalf("RenderRunTimeline() error = %v", err)
	}
	out := stdout.String()
	for _, want := range []string{"CI: main #9007199254740993 (attempt 1): failure", "+7s", "runner-a", "WAIT"} {
		if !strings.Contains(out, want) {
			t.Errorf("output does not contain %q:\n%s", want, out)
		}
	}
}
