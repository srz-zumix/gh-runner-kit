package kitutil

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/spf13/cobra"
)

const (
	TypeOrg  = "org"
	TypeRepo = "repo"
)

// AddTypeFlag registers the --type flag along with its shell completion.
func AddTypeFlag(cmd *cobra.Command, runnerType *string) {
	cmdutil.StringEnumFlag(cmd, runnerType, "type", "", TypeOrg, []string{TypeOrg, TypeRepo}, "Runner type to target (--repo implies repo)")
}

// ApplyRunnerType narrows repo to the runner type to target.
// An explicit --repo implies the repository runner type unless --type is given too.
func ApplyRunnerType(cmd *cobra.Command, repo repository.Repository, runnerType string) (repository.Repository, error) {
	if !cmd.Flags().Changed("type") && cmd.Flags().Changed("repo") {
		runnerType = TypeRepo
	}

	if runnerType == TypeOrg {
		repo.Name = ""
		return repo, nil
	}
	if repo.Name == "" {
		return repo, fmt.Errorf("--type repo requires a repository: use --repo, or run inside a repository")
	}
	return repo, nil
}
