package billing

import (
	"fmt"

	"github.com/srz-zumix/go-gh-extension/pkg/gh"
)

// Period is the reporting period of a billing usage request; zero values mean "not specified".
type Period struct {
	Year         int
	Month        int
	Day          int
	Hour         *int
	CostCenterID string
}

// Validate checks the ranges and the options that only apply to some targets.
func (p Period) Validate(enterprise bool) error {
	if p.Year != 0 && (p.Year < 1000 || p.Year > 9999) {
		return fmt.Errorf("invalid year %d: must have four digits", p.Year)
	}
	if p.Month != 0 && (p.Month < 1 || p.Month > 12) {
		return fmt.Errorf("invalid month %d: must be between 1 and 12", p.Month)
	}
	if p.Day != 0 && (p.Day < 1 || p.Day > 31) {
		return fmt.Errorf("invalid day %d: must be between 1 and 31", p.Day)
	}
	if p.Hour != nil && (*p.Hour < 0 || *p.Hour > 23) {
		return fmt.Errorf("invalid hour %d: must be between 0 and 23", *p.Hour)
	}
	if enterprise && p.Hour != nil {
		return fmt.Errorf("--hour is not supported for enterprise reports")
	}
	if !enterprise && p.CostCenterID != "" {
		return fmt.Errorf("--cost-center is supported for enterprise reports only")
	}
	return nil
}

// UsageOptions returns the options of a usage report request.
func (p Period) UsageOptions() *gh.BillingUsageOptions {
	return &gh.BillingUsageOptions{Year: p.Year, Month: p.Month, Day: p.Day, Hour: p.Hour, CostCenterID: p.CostCenterID}
}

// SummaryOptions returns the options of a usage summary request. An empty value leaves that filter out.
func (p Period) SummaryOptions(repository, product, sku string) *gh.BillingUsageSummaryOptions {
	return &gh.BillingUsageSummaryOptions{
		Year: p.Year, Month: p.Month, Day: p.Day, CostCenterID: p.CostCenterID,
		Repository: repository, Product: product, SKU: sku,
	}
}
