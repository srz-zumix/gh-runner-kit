package metrics

import (
	"testing"
	"time"

	"github.com/google/go-github/v90/github"
)

// sec returns a timestamp the given number of seconds after the fixture origin.
func sec(s int) github.Timestamp {
	return github.Timestamp{Time: at(0).Add(time.Duration(s) * time.Second)}
}

func testStep(number int64, name, conclusion string, started, completed int) *github.TaskStep {
	step := &github.TaskStep{
		Number:     github.Ptr(number),
		Name:       github.Ptr(name),
		Status:     github.Ptr("completed"),
		Conclusion: github.Ptr(conclusion),
	}
	if started >= 0 {
		step.StartedAt = github.Ptr(sec(started))
	}
	if completed >= 0 {
		step.CompletedAt = github.Ptr(sec(completed))
	}
	return step
}

func testStepJob(id, runID int64, attempt int64, name, conclusion string, started, completed int, steps ...*github.TaskStep) *github.WorkflowJob {
	return &github.WorkflowJob{
		ID:           github.Ptr(id),
		RunID:        github.Ptr(runID),
		RunAttempt:   github.Ptr(attempt),
		WorkflowName: github.Ptr("CI"),
		Name:         github.Ptr(name),
		Status:       github.Ptr("completed"),
		Conclusion:   github.Ptr(conclusion),
		RunnerID:     github.Ptr(int64(1)),
		RunnerName:   github.Ptr("runner-a"),
		Labels:       []string{"self-hosted", "linux"},
		CreatedAt:    github.Ptr(sec(started - 5)),
		StartedAt:    github.Ptr(sec(started)),
		CompletedAt:  github.Ptr(sec(completed)),
		Steps:        steps,
	}
}

// stepData holds three runs of one workflow. Run 1 is on its second attempt, and its
// "lint" job was carried over from the first attempt.
func stepData() *Data {
	return &Data{
		Window: Window{Start: at(0), End: at(60)},
		Runners: []*github.Runner{
			testRunner(1, "runner-a", "online", false, "self-hosted", "linux"),
		},
		Runs: []*github.WorkflowRun{
			{ID: github.Ptr(int64(1)), RunAttempt: github.Ptr(2), RunStartedAt: github.Ptr(sec(0)), Path: github.Ptr(".github/workflows/ci.yml"), Event: github.Ptr("push")},
			{ID: github.Ptr(int64(2)), RunAttempt: github.Ptr(1), RunStartedAt: github.Ptr(sec(100)), Path: github.Ptr(".github/workflows/ci.yml"), Event: github.Ptr("push")},
			{ID: github.Ptr(int64(3)), RunAttempt: github.Ptr(1), RunStartedAt: github.Ptr(sec(200)), Path: github.Ptr(".github/workflows/ci.yml"), Event: github.Ptr("push")},
		},
		RunRepositories: map[int64]string{1: "octo/app", 2: "octo/app", 3: "octo/app"},
		Jobs: []*github.WorkflowJob{
			testStepJob(10, 1, 2, "build", "success", 10, 50,
				testStep(1, "Set up job", "success", 10, 12),
				testStep(2, "Run actions/checkout@v4", "success", 12, 15),
				testStep(3, "Compile", "success", 15, 45),
				testStep(4, "Upload", "success", 45, 48),
				testStep(5, "Upload", "success", 48, 50),
			),
			testStepJob(11, 1, 1, "lint", "success", 5, 20,
				testStep(1, "Set up job", "success", 5, 6),
				testStep(2, "Lint", "success", 6, 20),
			),
			testStepJob(20, 2, 1, "build", "failure", 110, 140,
				testStep(1, "Set up job", "success", 110, 111),
				testStep(2, "Run actions/checkout@v4", "success", 111, 113),
				testStep(3, "Compile", "failure", 113, 140),
				testStep(4, "Upload", "skipped", -1, -1),
			),
			testStepJob(30, 3, 1, "build", "success", 210, 260,
				// The steps arrive out of order, which the listing has to fix.
				testStep(3, "Compile", "success", 215, 255),
				testStep(1, "Set up job", "success", 210, 212),
				testStep(2, "Run actions/checkout@v4", "success", 212, 215),
			),
		},
	}
}

func stepKeys(rows []StepRow) []string {
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, row.JobName+"/"+row.StepKey)
	}
	return keys
}

func TestBuildStepRows(t *testing.T) {
	cases := []struct {
		name string
		opts StepRowOptions
		want []string
	}{
		{
			name: "every step, by job start then step number",
			want: []string{
				"lint/Set up job", "lint/Lint",
				"build/Set up job", "build/Run actions/checkout@v4", "build/Compile", "build/Upload", "build/Upload #2",
				"build/Set up job", "build/Run actions/checkout@v4", "build/Compile", "build/Upload",
				"build/Set up job", "build/Run actions/checkout@v4", "build/Compile",
			},
		},
		{
			name: "job filter",
			opts: StepRowOptions{Jobs: []string{"li*"}},
			want: []string{"lint/Set up job", "lint/Lint"},
		},
		{
			name: "step wildcard matches across a slash",
			opts: StepRowOptions{Steps: []string{"*checkout*"}},
			want: []string{"build/Run actions/checkout@v4", "build/Run actions/checkout@v4", "build/Run actions/checkout@v4"},
		},
		{
			name: "limit caps the rows",
			opts: StepRowOptions{JobRowOptions: JobRowOptions{Limit: 3}},
			want: []string{"lint/Set up job", "lint/Lint", "build/Set up job"},
		},
		{
			name: "job row filters apply",
			opts: StepRowOptions{JobRowOptions: JobRowOptions{Kind: JobKindFilterHosted}},
			want: []string{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := stepKeys(BuildStepRows(stepData(), tc.opts))
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestBuildStepRowsFields(t *testing.T) {
	rows := BuildStepRows(stepData(), StepRowOptions{})

	compile := rows[4]
	if compile.StepName != "Compile" || compile.JobID != 10 {
		t.Fatalf("unexpected row %+v", compile)
	}
	if compile.Duration != 30*time.Second || compile.Offset != 5*time.Second {
		t.Errorf("duration %v offset %v, want 30s and 5s", compile.Duration, compile.Offset)
	}
	if compile.RunStartedAt == nil || !compile.RunStartedAt.Equal(sec(0).Time) {
		t.Errorf("RunStartedAt = %v, want the run start", compile.RunStartedAt)
	}
	if compile.Repo != "octo/app" || compile.WorkflowPath != ".github/workflows/ci.yml" || compile.Event != "push" {
		t.Errorf("job identity not copied: %+v", compile)
	}

	// The lint job belongs to the first attempt, whose start GitHub no longer reports.
	if rows[0].RunStartedAt != nil {
		t.Errorf("carried over job reports RunStartedAt %v, want unset", rows[0].RunStartedAt)
	}

	skipped := rows[10]
	if skipped.StepConclusion != "skipped" || skipped.StartedAt != nil || skipped.Duration != 0 || skipped.Offset != 0 {
		t.Errorf("skipped step = %+v, want unset times", skipped)
	}
}

func TestMatchWildcard(t *testing.T) {
	cases := []struct {
		pattern, name string
		want          bool
	}{
		{"Compile", "Compile", true},
		{"Compile", "compile", false},
		{"*", "", true},
		{"Run *", "Run actions/checkout@v4", true},
		{"*checkout*", "Run actions/checkout@v4", true},
		{"a*b*c", "abc", true},
		{"a*b*c", "aXbYbZc", true},
		{"a*b*c", "acb", false},
		{"ab*ba", "aba", false},
		{"build (*)", "build (ubuntu, 1.2)", true},
		{"[x]", "[x]", true},
	}
	for _, tc := range cases {
		if got := MatchWildcard(tc.pattern, tc.name); got != tc.want {
			t.Errorf("MatchWildcard(%q, %q) = %v, want %v", tc.pattern, tc.name, got, tc.want)
		}
	}
}

func TestStepRowOptionsValidate(t *testing.T) {
	if err := (StepRowOptions{Steps: []string{""}}).Validate(); err == nil {
		t.Error("an empty --step pattern was accepted")
	}
	if err := (StepRowOptions{Jobs: []string{""}}).Validate(); err == nil {
		t.Error("an empty --job pattern was accepted")
	}
	if err := (StepRowOptions{JobRowOptions: JobRowOptions{Runners: []string{"["}}}).Validate(); err == nil {
		t.Error("a malformed --runner pattern was accepted")
	}
	if err := (StepRowOptions{Steps: []string{"Run *"}}).Validate(); err != nil {
		t.Errorf("a valid pattern was rejected: %v", err)
	}
}
