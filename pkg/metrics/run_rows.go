package metrics

import (
	"cmp"
	"slices"
	"time"
)

// RunRow is one workflow run returned by the Actions runs endpoint.
type RunRow struct {
	Repository   string
	Workflow     string
	WorkflowPath string
	WorkflowID   int64
	RunID        int64
	RunNumber    int
	RunAttempt   int
	Event        string
	Branch       string
	HeadSHA      string
	Status       string
	Conclusion   string
	CreatedAt    *time.Time
	StartedAt    *time.Time
	UpdatedAt    *time.Time
	HTMLURL      string
}

// BuildRunRows turns collected workflow runs into a deterministic run listing.
func BuildRunRows(data *Data) []RunRow {
	rows := make([]RunRow, 0, len(data.Runs))
	for _, run := range data.Runs {
		rows = append(rows, RunRow{
			Repository:   data.RunRepositories[run.GetID()],
			Workflow:     run.GetName(),
			WorkflowPath: run.GetPath(),
			WorkflowID:   run.GetWorkflowID(),
			RunID:        run.GetID(),
			RunNumber:    run.GetRunNumber(),
			RunAttempt:   run.GetRunAttempt(),
			Event:        run.GetEvent(),
			Branch:       run.GetHeadBranch(),
			HeadSHA:      run.GetHeadSHA(),
			Status:       run.GetStatus(),
			Conclusion:   run.GetConclusion(),
			CreatedAt:    optionalTime(run.GetCreatedAt().Time),
			StartedAt:    optionalTime(run.GetRunStartedAt().Time),
			UpdatedAt:    optionalTime(run.GetUpdatedAt().Time),
			HTMLURL:      run.GetHTMLURL(),
		})
	}

	slices.SortFunc(rows, func(a, b RunRow) int {
		if c := compareOptionalTime(a.CreatedAt, b.CreatedAt); c != 0 {
			return c
		}
		return cmp.Compare(a.RunID, b.RunID)
	})
	return rows
}
