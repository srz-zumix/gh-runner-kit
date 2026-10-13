package billing

import (
	"fmt"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/internal/kitutil"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func NewUsageCmd() *cobra.Command {
	var flags kitutil.BillingFlags
	var groupByFlag string

	cmd := &cobra.Command{
		Use:   "usage",
		Short: "List the billing usage lines of an organization, user or enterprise",
		Long: `List the lines of the billing usage report: the date, product, SKU, quantity, unit,
price and gross, discount and net amounts of what was used.

The account is taken from --enterprise, --user or --owner, or from the owner of --repo
or of the current repository. Only the lines of --product are shown (default: actions;
pass an empty value for every product). The report covers the current year unless
--year, --month, --day or --hour narrow it, and only the last 24 months are available.
Use --cost-center to report a single enterprise cost center.

The billing API has no repository endpoint, so --repo reports the organization and
keeps the lines of that repository. Use --group-by to sum the lines by date, org,
product, repo or sku instead of listing them.

Reading organization usage requires organization owner or billing manager access;
enterprise usage requires enterprise owner or billing manager access. The enhanced
billing platform is required. Amounts are in USD and are not an invoice.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := flags.Prepare(cmd); err != nil {
				return err
			}
			groupBy, err := gh.ParseBillingGroupBy(groupByFlag)
			if err != nil {
				return err
			}
			repo, client, err := flags.Resolve()
			if err != nil {
				return err
			}

			var rows []gh.BillingUsageRow
			switch {
			case flags.IsEnterprise():
				report, err := gh.GetEnterpriseUsageReport(cmd.Context(), client, repo, flags.Period.UsageOptions())
				if err != nil {
					return fmt.Errorf("failed to get the billing usage report of enterprise %s: %w", repo.Owner, err)
				}
				rows = gh.BillingUsageRowsFromEnterpriseReport(report)
			case flags.IsUser():
				report, err := gh.GetUserUsageReport(cmd.Context(), client, repo, flags.Period.UsageOptions())
				if err != nil {
					return fmt.Errorf("failed to get the billing usage report of user %s: %w", repo.Owner, err)
				}
				rows = gh.BillingUsageRowsFromReport(report)
			default:
				report, err := gh.GetOrgUsageReport(cmd.Context(), client, repo, flags.Period.UsageOptions())
				if err != nil {
					return fmt.Errorf("failed to get the billing usage report of organization %s: %w", repo.Owner, err)
				}
				rows = gh.BillingUsageRowsFromReport(report)
			}

			rows = gh.FilterBillingUsageRows(rows, flags.Product, flags.RepositoryFilter(repo))
			return render.NewRenderer(flags.Exporter).RenderBillingUsage(rows, groupBy)
		},
	}

	flags.Add(cmd, true)
	cmd.Flags().StringVar(&groupByFlag, "group-by", "", fmt.Sprintf("Sum the usage lines by one of %v instead of listing them (default: list the lines)", gh.BillingGroupByValues()))

	return cmd
}
