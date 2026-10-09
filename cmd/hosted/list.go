package hosted

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewListCmd() *cobra.Command {
	var repoFlag, ownerFlag, enterpriseFlag string
	var nameOnly, excludeInherited bool
	var fields []string
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List GitHub-hosted runners",
		Long: `List the GitHub-hosted runner pools configured in an organization or enterprise, including larger runners.

The organization is taken from --owner, or from the owner of --repo or of the
current repository. Organization listing also includes the pools of runner
groups inherited from the enterprise, which only needs organization admin
permission; use --exclude-inherited to list only the organization pools.
Use --enterprise [HOST/]ENTERPRISE to list the pools
configured in an enterprise instead; it cannot be combined with --owner or --repo.
Enterprise listing requires manage_runners:enterprise for classic personal access
tokens. This does not list standard hosted runner labels such as ubuntu-latest.
Reading organization hosted runners requires organization administration read
permission. Use --fields to choose the table columns.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ownerInput := ownerFlag
			listRunners := gh.ListOrgHostedRunnersWithInherited
			if excludeInherited {
				listRunners = gh.ListOrgHostedRunners
			}
			if enterpriseFlag != "" {
				ownerInput = enterpriseFlag
				listRunners = gh.ListEnterpriseHostedRunners
			}
			repo, client, err := kitutil.ResolveOrganization(ownerInput, repoFlag)
			if err != nil {
				return err
			}
			runners, err := listRunners(cmd.Context(), client, repo)
			if err != nil {
				return fmt.Errorf("failed to list GitHub-hosted runners of %s: %w", repo.Owner, err)
			}
			r := render.NewRenderer(exporter)
			if nameOnly {
				return r.RenderNames(runners)
			}
			return kitutil.RenderHostedRunners(r, runners, fields)
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name")
	f.StringVar(&enterpriseFlag, "enterprise", "", "Select an enterprise using the [HOST/]ENTERPRISE format")
	f.BoolVar(&excludeInherited, "exclude-inherited", false, "Do not list the pools of runner groups inherited from the enterprise")
	f.BoolVar(&nameOnly, "name-only", false, "Print only the runner names")
	cmdutil.StringSliceEnumFlag(cmd, &fields, "fields", "", nil, kitutil.HostedRunnerFields(), "Table columns to display")
	cmdutil.AddFormatFlags(cmd, &exporter)
	cmd.MarkFlagsMutuallyExclusive("enterprise", "owner")
	cmd.MarkFlagsMutuallyExclusive("enterprise", "repo")
	cmd.MarkFlagsMutuallyExclusive("enterprise", "exclude-inherited")
	return cmd
}
