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

func TestBuildMetricsReportTimeZone(t *testing.T) {
	start := time.Date(2026, 10, 27, 13, 30, 0, 0, time.UTC)
	data := &metrics.Data{Window: metrics.Window{Start: start, End: start.Add(24 * time.Hour)}}
	report, err := BuildMetricsReport(data, []ReportSection{ReportSectionConcurrency}, ReportOptions{
		Bucket: 24 * time.Hour, TimeZone: "Asia/Tokyo",
	})
	if err != nil {
		t.Fatal(err)
	}
	if report.Window != data.Window || len(report.Concurrency) != 2 ||
		!report.Concurrency[0].Start.Equal(data.Window.Start) ||
		!report.Concurrency[0].End.Equal(start.Add(90*time.Minute)) ||
		!report.Concurrency[1].End.Equal(data.Window.End) {
		t.Fatalf("report did not preserve the window and align to JST midnight: %+v", report)
	}
	_, err = BuildMetricsReport(data, []ReportSection{ReportSectionConcurrency}, ReportOptions{
		Bucket: time.Hour, TimeZone: "Invalid/Example",
	})
	if err == nil || !strings.Contains(err.Error(), "invalid --time-zone") {
		t.Fatalf("invalid time zone error = %v", err)
	}
}
