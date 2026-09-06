package group

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/runnergroup"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewReposCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var nameOnly bool
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "repos <group>",
		Short: "List the repositories that can use an organization runner group",
		Long: `List the repositories that have access to an organization runner group.

The runner group is selected by name or by ID. Only runner groups whose
visibility is "selected" have a repository access list.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Reading runner groups requires organization owner permission.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			selector := args[0]

			repo, client, err := runnergroup.Organization(ownerFlag, repoFlag)
			if err != nil {
				return err
			}

			group, err := runnergroup.Find(ctx, client, repo, selector)
			if err != nil {
				return err
			}

			repos, err := gh.ListOrgRunnerGroupRepositories(ctx, client, repo, group.GetID())
			if err != nil {
				return fmt.Errorf("failed to list the repositories of runner group %q: %w", group.GetName(), err)
			}

			r := render.NewRenderer(exporter)
			if nameOnly {
				return r.RenderNames(repos)
			}
			return r.RenderRepository(repos, nil)
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	f.BoolVar(&nameOnly, "name-only", false, "Print only the repository names")
	cmdutil.AddFormatFlags(cmd, &exporter)

	return cmd
}
