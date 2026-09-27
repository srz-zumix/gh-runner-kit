package kitutil

import (
	"strings"
	"testing"
	"time"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

func TestParseReportSectionsDefaultsExcludeCost(t *testing.T) {
	sections, err := ParseReportSections(nil)
	if err != nil {
		t.Fatalf("ParseReportSections(nil) error = %v, want nil", err)
	}
	for _, s := range sections {
		if s == ReportSectionCost {
			t.Fatalf("ParseReportSections(nil) = %v, want it to exclude cost", sections)
		}
	}
	if len(sections) != len(ReportSectionNames())-1 {
		t.Fatalf("ParseReportSections(nil) = %v, want every section but cost", sections)
	}
}

func TestParseReportSectionsCanonicalOrder(t *testing.T) {
	sections, err := ParseReportSections([]string{"cost", "summary", "runner"})
	if err != nil {
		t.Fatalf("ParseReportSections error = %v, want nil", err)
	}
	want := []ReportSection{ReportSectionSummary, ReportSectionRunner, ReportSectionCost}
	if len(sections) != len(want) {
		t.Fatalf("ParseReportSections = %v, want %v", sections, want)
	}
	for i, s := range want {
		if sections[i] != s {
			t.Fatalf("ParseReportSections = %v, want %v", sections, want)
		}
	}
}

func TestParseReportSectionsRejectsUnknown(t *testing.T) {
	_, err := ParseReportSections([]string{"bogus"})
	if err == nil || !strings.Contains(err.Error(), "invalid --section") {
		t.Fatalf("ParseReportSections([bogus]) error = %v, want an invalid --section error", err)
	}
}

func TestBuildMetricsReportOnlyFillsRequestedSections(t *testing.T) {
	data := &metrics.Data{
		Window:          metrics.Window{Start: time.Now().Add(-time.Hour), End: time.Now()},
		RunRepositories: map[int64]string{},
	}

	report, err := BuildMetricsReport(data, []ReportSection{ReportSectionSummary, ReportSectionQueue}, ReportOptions{})
	if err != nil {
		t.Fatalf("BuildMetricsReport error = %v, want nil", err)
	}
	if report.Summary == nil {
		t.Fatal("BuildMetricsReport: Summary = nil, want the summary section built")
	}
	if report.Queue == nil {
		t.Fatal("BuildMetricsReport: Queue = nil, want the queue section built")
	}
	if report.Runner != nil {
		t.Fatalf("BuildMetricsReport: Runner = %v, want nil since it was not requested", report.Runner)
	}
	if report.Cost != nil {
		t.Fatalf("BuildMetricsReport: Cost = %v, want nil since it was not requested", report.Cost)
	}
}
