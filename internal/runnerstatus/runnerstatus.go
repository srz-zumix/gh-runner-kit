package runnerstatus

import (
	"strings"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/google/go-github/v90/github"
	"github.com/spf13/cobra"
)

// The runner APIs only report online and offline, so active and idle are
// derived from the busy field the way the GitHub UI presents them.
const (
	Online  = "online"
	Offline = "offline"
	Active  = "active"
	Idle    = "idle"
)

// AddFlag registers the --status flag along with its shell completion.
func AddFlag(cmd *cobra.Command, status *string) {
	cmdutil.StringEnumFlag(cmd, status, "status", "", "", []string{Online, Offline, Active, Idle}, "Keep only the runners in this status")
}

// Filter returns the runners matching status, or every runner when status is empty.
func Filter(runners []*github.Runner, status string) []*github.Runner {
	if status == "" {
		return runners
	}

	matched := make([]*github.Runner, 0, len(runners))
	for _, runner := range runners {
		if matches(runner, status) {
			matched = append(matched, runner)
		}
	}
	return matched
}

func matches(runner *github.Runner, status string) bool {
	switch strings.ToLower(status) {
	case Active:
		return strings.EqualFold(runner.GetStatus(), Online) && runner.GetBusy()
	case Idle:
		return strings.EqualFold(runner.GetStatus(), Online) && !runner.GetBusy()
	default:
		return strings.EqualFold(runner.GetStatus(), status)
	}
}
