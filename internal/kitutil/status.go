package kitutil

import (
	"strings"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/google/go-github/v90/github"
	"github.com/spf13/cobra"
)

// The runner APIs only report online and offline, so active and idle are
// derived from the busy field the way the GitHub UI presents them.
const (
	StatusOnline  = "online"
	StatusOffline = "offline"
	StatusActive  = "active"
	StatusIdle    = "idle"
)

// AddStatusFlag registers the --status flag along with its shell completion.
func AddStatusFlag(cmd *cobra.Command, status *string) {
	cmdutil.StringEnumFlag(cmd, status, "status", "", "", []string{StatusOnline, StatusOffline, StatusActive, StatusIdle}, "Keep only the runners in this status")
}

// FilterByStatus returns the runners matching status, or every runner when status is empty.
func FilterByStatus(runners []*github.Runner, status string) []*github.Runner {
	if status == "" {
		return runners
	}

	matched := make([]*github.Runner, 0, len(runners))
	for _, runner := range runners {
		if matchesStatus(runner, status) {
			matched = append(matched, runner)
		}
	}
	return matched
}

func matchesStatus(runner *github.Runner, status string) bool {
	switch strings.ToLower(status) {
	case StatusActive:
		return strings.EqualFold(runner.GetStatus(), StatusOnline) && runner.GetBusy()
	case StatusIdle:
		return strings.EqualFold(runner.GetStatus(), StatusOnline) && !runner.GetBusy()
	default:
		return strings.EqualFold(runner.GetStatus(), status)
	}
}
