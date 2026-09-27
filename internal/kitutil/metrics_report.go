package kitutil

import (
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

// ReportSection names one of the aggregated reports `metrics report` can print.
type ReportSection string

// The sections `metrics report` knows how to build.
const (
	ReportSectionSummary     ReportSection = "summary"
	ReportSectionRunner      ReportSection = "runner"
	ReportSectionQueue       ReportSection = "queue"
	ReportSectionConcurrency ReportSection = "concurrency"
	ReportSectionLabel       ReportSection = "label"
	ReportSectionWorkflow    ReportSection = "workflow"
	ReportSectionRepository  ReportSection = "repository"
	ReportSectionCapacity    ReportSection = "capacity"
	ReportSectionCost        ReportSection = "cost"
)

// reportSectionOrder is the canonical order sections are validated, built and printed
// in, regardless of the order --section repeated them in.
var reportSectionOrder = []ReportSection{
	ReportSectionSummary,
	ReportSectionRunner,
	ReportSectionQueue,
	ReportSectionConcurrency,
	ReportSectionLabel,
	ReportSectionWorkflow,
	ReportSectionRepository,
	ReportSectionCapacity,
	ReportSectionCost,
}

// ReportSectionNames lists every accepted --section value, for the flag help text and
// input validation.
func ReportSectionNames() []string {
	names := make([]string, len(reportSectionOrder))
	for i, s := range reportSectionOrder {
		names[i] = string(s)
	}
	return names
}

// ParseReportSections resolves --section into the canonical, deduplicated set of
// sections to build. No --section defaults to every section except cost, which costs
// one extra API request per run that the other sections never need.
func ParseReportSections(names []string) ([]ReportSection, error) {
	if len(names) == 0 {
		return slices.DeleteFunc(slices.Clone(reportSectionOrder), func(s ReportSection) bool {
			return s == ReportSectionCost
		}), nil
	}

	wanted := make(map[ReportSection]bool, len(names))
	for _, name := range names {
		s := ReportSection(name)
		if !slices.Contains(reportSectionOrder, s) {
			return nil, fmt.Errorf("invalid --section %q: expected one of %s", name, strings.Join(ReportSectionNames(), ", "))
		}
		wanted[s] = true
	}

	sections := make([]ReportSection, 0, len(wanted))
	for _, s := range reportSectionOrder {
		if wanted[s] {
			sections = append(sections, s)
		}
	}
	return sections, nil
}

// ReportOptions carries the section-specific parameters `metrics report` resolves from
// its flags, already validated against the collection window.
type ReportOptions struct {
	GroupBy metrics.Grouping
	// Bucket is the concurrency timeline's bucket width, already validated against the
	// collection window.
	Bucket time.Duration
	// Labels narrows the concurrency section to the jobs whose runs-on set carries
	// every given label; no other section accepts a label filter.
	Labels            []string
	SelfHostedOnly    bool
	IncludeUnused     bool
	TargetWait        time.Duration
	TargetUtilization float64
	Rates             map[string]float64
}

// Report holds the data every requested section built, keyed by section name so a
// JSON export matches --section by name. A section left out of --section stays nil,
// which the JSON exporter renders as an absent key rather than an empty array.
type Report struct {
	Window         metrics.Window `json:"window"`
	Runs           int            `json:"runs"`
	TruncatedRepos int            `json:"truncatedRepos"`
	Warnings       []string       `json:"warnings,omitempty"`

	Summary     *metrics.Summary         `json:"summary,omitempty"`
	Runner      []metrics.RunnerRow      `json:"runner,omitempty"`
	Queue       []metrics.QueueRow       `json:"queue,omitempty"`
	Concurrency []metrics.ConcurrencyRow `json:"concurrency,omitempty"`
	Label       []metrics.LabelRow       `json:"label,omitempty"`
	Workflow    []metrics.WorkflowRow    `json:"workflow,omitempty"`
	Repository  []metrics.RepositoryRow  `json:"repository,omitempty"`
	Capacity    []metrics.CapacityRow    `json:"capacity,omitempty"`
	Cost        []metrics.CostRow        `json:"cost,omitempty"`
}

// BuildMetricsReport builds every requested section from data, using only the opts
// fields those sections need.
func BuildMetricsReport(data *metrics.Data, sections []ReportSection, opts ReportOptions) (*Report, error) {
	report := &Report{
		Window:         data.Window,
		Runs:           len(data.Runs),
		TruncatedRepos: data.TruncatedRepos(),
		Warnings:       data.Warnings,
	}

	for _, section := range sections {
		switch section {
		case ReportSectionSummary:
			s := metrics.BuildSummary(data)
			report.Summary = &s
		case ReportSectionRunner:
			report.Runner = metrics.BuildRunnerStats(data, opts.GroupBy)
		case ReportSectionQueue:
			report.Queue = metrics.BuildQueueStats(data)
		case ReportSectionConcurrency:
			rows, err := metrics.BuildConcurrencyStats(data, opts.Bucket, opts.Labels)
			if err != nil {
				return nil, err
			}
			report.Concurrency = rows
		case ReportSectionLabel:
			report.Label = metrics.BuildLabelStats(data, opts.IncludeUnused)
		case ReportSectionWorkflow:
			report.Workflow = metrics.BuildWorkflowStats(data, opts.SelfHostedOnly)
		case ReportSectionRepository:
			report.Repository = metrics.BuildRepositoryStats(data)
		case ReportSectionCapacity:
			report.Capacity = metrics.BuildCapacityStats(data, opts.TargetWait, opts.TargetUtilization)
		case ReportSectionCost:
			rows, warnings := metrics.BuildCostStats(data, opts.Rates)
			report.Cost = rows
			report.Warnings = append(report.Warnings, warnings...)
		}
	}
	return report, nil
}

// RenderMetricsReport prints report as one combined JSON object when r has an
// exporter, or as a heading followed by a table per section otherwise.
func RenderMetricsReport(r *render.Renderer, report *Report, sections []ReportSection) error {
	if r.HasExporter() {
		return r.RenderExportedData(report)
	}

	for i, section := range sections {
		if i > 0 {
			r.WriteLine("")
		}
		r.WriteLine("== " + strings.ToUpper(string(section)) + " ==")
		if err := renderReportSectionTable(r, report, section); err != nil {
			return err
		}
	}
	WriteMetricsFooter(r, report.Window, report.Runs, report.TruncatedRepos, report.Warnings)
	return nil
}

// renderReportSectionTable prints the table of a single section. r is assumed to have
// no exporter, which RenderMetricsReport already established before calling this.
func renderReportSectionTable(r *render.Renderer, report *Report, section ReportSection) error {
	switch section {
	case ReportSectionSummary:
		if report.Summary == nil {
			return nil
		}
		return RenderMetricsSummaryTable(r, *report.Summary)
	case ReportSectionRunner:
		return RenderMetricsRunners(r, report.Runner)
	case ReportSectionQueue:
		return RenderMetricsQueue(r, report.Queue)
	case ReportSectionConcurrency:
		return RenderMetricsConcurrency(r, report.Concurrency)
	case ReportSectionLabel:
		return RenderMetricsLabels(r, report.Label)
	case ReportSectionWorkflow:
		return RenderMetricsWorkflows(r, report.Workflow)
	case ReportSectionRepository:
		return RenderMetricsRepositories(r, report.Repository)
	case ReportSectionCapacity:
		return RenderMetricsCapacity(r, report.Capacity)
	case ReportSectionCost:
		return RenderMetricsCost(r, report.Cost)
	default:
		return nil
	}
}
