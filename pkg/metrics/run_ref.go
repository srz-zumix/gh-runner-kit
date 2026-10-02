package metrics

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/cli/go-gh/v2/pkg/repository"
)

// RunRef points at one workflow run, optionally at one attempt of it and one job in it.
type RunRef struct {
	// Repo is the repository the reference names, or nil when it is a bare run ID that
	// leaves the repository to the caller.
	Repo  *repository.Repository
	RunID int64
	// Attempt is the run attempt the reference names, or 0 for the latest attempt.
	Attempt int
	// JobID is the job the reference names, or 0 when it names the whole run.
	JobID int64
}

// ParseRunRef parses a workflow run reference, which is either a run ID or the URL of a
// run as GitHub renders it:
//
//	https://HOST/OWNER/REPO/actions/runs/RUN_ID
//	https://HOST/OWNER/REPO/actions/runs/RUN_ID/attempts/ATTEMPT
//	https://HOST/OWNER/REPO/actions/runs/RUN_ID/job/JOB_ID
//	https://HOST/OWNER/REPO/actions/runs/RUN_ID/attempts/ATTEMPT/job/JOB_ID
func ParseRunRef(input string) (RunRef, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return RunRef{}, fmt.Errorf("run reference must not be empty")
	}
	if !strings.HasPrefix(input, "http://") && !strings.HasPrefix(input, "https://") {
		id, err := parsePositiveID(input)
		if err != nil {
			return RunRef{}, fmt.Errorf("expected a run ID or a workflow run URL, got %q", input)
		}
		return RunRef{RunID: id}, nil
	}

	u, err := url.Parse(input)
	if err != nil {
		return RunRef{}, fmt.Errorf("invalid workflow run URL %q: %w", input, err)
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 5 || parts[2] != "actions" || parts[3] != "runs" || parts[0] == "" || parts[1] == "" {
		return RunRef{}, fmt.Errorf("expected a URL of the form https://HOST/OWNER/REPO/actions/runs/RUN_ID, got %q", input)
	}
	runID, err := parsePositiveID(parts[4])
	if err != nil {
		return RunRef{}, fmt.Errorf("invalid run ID in %q", input)
	}
	ref := RunRef{
		Repo:  &repository.Repository{Host: u.Host, Owner: parts[0], Name: parts[1]},
		RunID: runID,
	}

	rest := parts[5:]
	if len(rest) >= 2 && rest[0] == "attempts" {
		attempt, err := parsePositiveID(rest[1])
		if err != nil {
			return RunRef{}, fmt.Errorf("invalid attempt in %q", input)
		}
		ref.Attempt = int(attempt)
		rest = rest[2:]
	}
	if len(rest) >= 2 && rest[0] == "job" {
		jobID, err := parsePositiveID(rest[1])
		if err != nil {
			return RunRef{}, fmt.Errorf("invalid job ID in %q", input)
		}
		ref.JobID = jobID
		rest = rest[2:]
	}
	// Trailing segments such as "workflow" or "usage" are pages of the same run.
	if len(rest) > 1 {
		return RunRef{}, fmt.Errorf("unsupported workflow run URL %q", input)
	}
	return ref, nil
}

func parsePositiveID(s string) (int64, error) {
	id, err := strconv.ParseInt(s, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid ID %q", s)
	}
	return id, nil
}
