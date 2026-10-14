package billing

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewSummaryCmd() *cobra.Command {
	var flags kitutil.BillingFlags
	var sku string

	cmd := &cobra.Command{
		Use:   "summary",
		Short: "Show the billing usage summary of an organization, user or enterprise",
		Long: `Show the billing usage summary: the gross, discount and net quantity and amount of each
product and SKU used in the period.

The account is taken from --enterprise, --user or --owner, or from the owner of --repo
or of the current repository. Only --product is summarized (default: actions; pass an
empty value for every product), optionally narrowed to one --sku. --repo summarizes a
single repository of the organization. The summary covers the current year unless
--year, --month or --day narrow it, and only the last 24 months are available.
Use --cost-center to summarize a single enterprise cost center.

This API is in public preview and may change. Reading organization usage requires
organization owner or billing manager access; enterprise usage requires enterprise owner
or billing manager access. Amounts are in USD and are not an invoice.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := flags.Prepare(cmd); err != nil {
				return err
			}
			repo, client, err := flags.Resolve()
			if err != nil {
				return err
			}
			opts := flags.Period.SummaryOptions(flags.RepositoryFilter(repo), flags.Product, sku)

			var summary *gh.BillingUsageSummary
			switch {
			case flags.IsEnterprise():
				summary, err = gh.GetEnterpriseUsageSummary(cmd.Context(), client, repo, opts)
				if err != nil {
					return fmt.Errorf("failed to get the billing usage summary of enterprise %s: %w", repo.Owner, err)
				}
			case flags.IsUser():
				summary, err = gh.GetUserUsageSummary(cmd.Context(), client, repo, opts)
				if err != nil {
					return fmt.Errorf("failed to get the billing usage summary of user %s: %w", repo.Owner, err)
				}
			default:
				summary, err = gh.GetOrgUsageSummary(cmd.Context(), client, repo, opts)
				if err != nil {
					return fmt.Errorf("failed to get the billing usage summary of organization %s: %w", repo.Owner, err)
				}
			}
			return render.NewRenderer(flags.Exporter).RenderBillingSummary(summary)
		},
	}

	flags.Add(cmd, false)
	cmd.Flags().StringVar(&sku, "sku", "", "Summarize only this SKU, such as actions_linux (default: every SKU)")

	return cmd
}
