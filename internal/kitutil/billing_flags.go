package kitutil

import (
	"strings"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/pkg/billing"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
)

// DefaultBillingProduct is the billing product the billing commands report unless --product says otherwise.
const DefaultBillingProduct = "actions"

// BillingFlags carries the options shared by the billing subcommands.
type BillingFlags struct {
	Repo       string
	Owner      string
	User       string
	Enterprise string
	Product    string
	Period     billing.Period
	Exporter   cmdutil.Exporter

	hour int
}

// Add registers the shared billing flags on cmd. withHour adds --hour, which only
// the usage report supports.
func (b *BillingFlags) Add(cmd *cobra.Command, withHour bool) {
	f := cmd.Flags()
	f.StringVarP(&b.Repo, "repo", "R", "", "Select a repository using the [HOST/]OWNER/REPO format")
	f.StringVar(&b.Owner, "owner", "", "Select an organization by owner name")
	f.StringVar(&b.User, "user", "", "Select a user account by name")
	f.StringVar(&b.Enterprise, "enterprise", "", "Select an enterprise using the [HOST/]ENTERPRISE format")
	f.IntVar(&b.Period.Year, "year", 0, "Report a single year, with four digits (default: the current year)")
	f.IntVar(&b.Period.Month, "month", 0, "Report a single month, 1-12 (default: the whole year)")
	f.IntVar(&b.Period.Day, "day", 0, "Report a single day, 1-31 (default: the whole month)")
	if withHour {
		f.IntVar(&b.hour, "hour", 0, "Report a single hour, 0-23 (organization and user only)")
	}
	f.StringVar(&b.Period.CostCenterID, "cost-center", "", "Report a single cost center by ID (enterprise only)")
	f.StringVar(&b.Product, "product", DefaultBillingProduct, "Report only this billing product; empty reports every product")
	cmdutil.AddFormatFlags(cmd, &b.Exporter)

	cmd.MarkFlagsMutuallyExclusive("enterprise", "owner")
	cmd.MarkFlagsMutuallyExclusive("enterprise", "user")
	cmd.MarkFlagsMutuallyExclusive("enterprise", "repo")
	cmd.MarkFlagsMutuallyExclusive("owner", "user")
	cmd.MarkFlagsMutuallyExclusive("repo", "user")
}

// Prepare validates the period against the selected target. Call it first in RunE.
func (b *BillingFlags) Prepare(cmd *cobra.Command) error {
	if f := cmd.Flags().Lookup("hour"); f != nil && f.Changed {
		b.Period.Hour = &b.hour
	}
	return b.Period.Validate(b.Enterprise != "")
}

// IsEnterprise reports whether an enterprise was selected.
func (b *BillingFlags) IsEnterprise() bool {
	return b.Enterprise != ""
}

// IsUser reports whether a user account was selected.
func (b *BillingFlags) IsUser() bool {
	return b.User != ""
}

// Resolve returns the account to report on, taken from --enterprise, --user, --owner or
// the owner of --repo or of the current repository, together with a client for it.
func (b *BillingFlags) Resolve() (repository.Repository, *gh.GitHubClient, error) {
	owner := b.Owner
	switch {
	case b.Enterprise != "":
		owner = b.Enterprise
	case b.User != "":
		owner = b.User
	}
	return ResolveOrganization(owner, b.Repo)
}

// RepositoryFilter returns the OWNER/REPO selected by --repo, or empty when no repository was selected.
func (b *BillingFlags) RepositoryFilter(repo repository.Repository) string {
	if b.Repo == "" {
		return ""
	}
	return strings.Join([]string{repo.Owner, repo.Name}, "/")
}
