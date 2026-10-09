package cmd

import (
	"fmt"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/parser"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewListCmd() *cobra.Command {
	var repoFlag string
	var ownerFlag string
	var enterpriseFlag string
	var excludeInherited bool
	var runnerType string
	var status string
	var nameOnly bool
	var fields []string
	var exporter cmdutil.Exporter

	cmd := &cobra.Command{
		Use:   "list",
		Short: "List self-hosted runners",
		Long: `List self-hosted runners, including their cordon status.

Organization-level runners are listed by default. Use --type repo to list the
runners registered to a repository instead, --status to keep only the runners in
one status, and --fields to choose the table columns.

Organization listing also includes the runners of runner groups inherited from
the enterprise, which only needs organization admin permission. Use
--exclude-inherited to list only the runners registered to the organization.

Use --enterprise [HOST/]ENTERPRISE to list the self-hosted runners registered
to an enterprise instead. This requires enterprise runner management permission
and cannot be combined with --owner, --repo or --type.

The runner APIs only report online and offline, so --status active and
--status idle match the online runners that are respectively running a job and
waiting for one.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			ownerInput := ownerFlag
			listRunners := gh.ListRunners
			if enterpriseFlag != "" {
				ownerInput = enterpriseFlag
				listRunners = gh.ListEnterpriseRunners
			}

			repo, err := parser.Repository(
				parser.RepositoryOwnerWithHost(ownerInput),
				parser.RepositoryInput(repoFlag),
			)
			if err != nil {
				return err
			}

			repo, err = kitutil.ApplyRunnerType(cmd, repo, runnerType)
			if err != nil {
				return err
			}
			if enterpriseFlag == "" && repo.Name == "" && !excludeInherited {
				listRunners = gh.ListOrgRunnersWithInherited
			}

			client, err := gh.NewGitHubClientWithRepo(repo)
			if err != nil {
				return err
			}

			runners, err := listRunners(ctx, client, repo)
			if err != nil {
				return fmt.Errorf("failed to list self-hosted runners of %s: %w", parser.GetRepositoryFullNameWithHost(repo), err)
			}
			runners = kitutil.FilterByStatus(runners, status)

			r := render.NewRenderer(exporter)
			if nameOnly {
				return r.RenderNames(runners)
			}
			return r.RenderRunnersWithFieldGetters(runners, kitutil.FieldHeaders(fields), kitutil.RunnerFieldGetters())
		},
	}

	f := cmd.Flags()
	f.StringVarP(&repoFlag, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&ownerFlag, "owner", "", "Select an organization by owner name (for organization-level runners)")
	f.StringVar(&enterpriseFlag, "enterprise", "", "Select an enterprise using the [HOST/]ENTERPRISE format")
	f.BoolVar(&excludeInherited, "exclude-inherited", false, "Do not list the runners of runner groups inherited from the enterprise")
	kitutil.AddTypeFlag(cmd, &runnerType)
	kitutil.AddStatusFlag(cmd, &status)
	f.BoolVar(&nameOnly, "name-only", false, "Print only the runner names")
	kitutil.AddFieldsFlag(cmd, &fields)
	cmdutil.AddFormatFlags(cmd, &exporter)
	cmd.MarkFlagsMutuallyExclusive("enterprise", "owner")
	cmd.MarkFlagsMutuallyExclusive("enterprise", "repo")
	cmd.MarkFlagsMutuallyExclusive("enterprise", "type")
	cmd.MarkFlagsMutuallyExclusive("enterprise", "exclude-inherited")

	return cmd
}

func init() {
	rootCmd.AddCommand(NewListCmd())
}
