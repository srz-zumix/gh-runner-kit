package metrics

// ExportReport bundles everything the export command publishes: the fleet overview, the
// per runs-on label set breakdown and the per label demand, so that every output format
// describes the same collection.
type ExportReport struct {
	Window Window
	// Repos carries the per repository coverage, so that a consumer can tell which
	// repositories the run limit cut short before comparing them.
	Repos   []RepoCoverage
	Summary Summary
	Pools   []QueueRow
	Labels  []LabelRow
}

// BuildExportReport assembles the report from a single collection.
func BuildExportReport(data *Data) ExportReport {
	return ExportReport{
		Window:  data.Window,
		Repos:   data.Repos,
		Summary: BuildSummary(data),
		Pools:   BuildQueueStats(data),
		Labels:  BuildLabelStats(data, false),
	}
}
