package billing

import "testing"

func intPtr(v int) *int { return &v }

func TestPeriodValidate(t *testing.T) {
	for _, test := range []struct {
		name       string
		period     Period
		enterprise bool
		wantErr    bool
	}{
		{"empty", Period{}, false, false},
		{"full", Period{Year: 2026, Month: 5, Day: 31, Hour: intPtr(0)}, false, false},
		{"bad year", Period{Year: 26}, false, true},
		{"bad month", Period{Month: 13}, false, true},
		{"bad day", Period{Day: 32}, false, true},
		{"bad hour", Period{Hour: intPtr(24)}, false, true},
		{"hour on enterprise", Period{Hour: intPtr(1)}, true, true},
		{"cost center on organization", Period{CostCenterID: "cc"}, false, true},
		{"cost center on enterprise", Period{CostCenterID: "cc"}, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.period.Validate(test.enterprise); (err != nil) != test.wantErr {
				t.Errorf("Validate() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestPeriodOptions(t *testing.T) {
	p := Period{Year: 2026, Month: 2, Day: 3, Hour: intPtr(4), CostCenterID: "cc"}
	u := p.UsageOptions()
	if u.Year != 2026 || u.Month != 2 || u.Day != 3 || *u.Hour != 4 || u.CostCenterID != "cc" {
		t.Errorf("unexpected usage options %+v", u)
	}
	s := p.SummaryOptions("example-org/repo", "actions", "actions_linux")
	if s.Year != 2026 || s.Repository != "example-org/repo" || s.Product != "actions" || s.SKU != "actions_linux" || s.CostCenterID != "cc" {
		t.Errorf("unexpected summary options %+v", s)
	}
}
