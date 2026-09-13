package metrics

// ExportReport bundles everything the export command publishes: the fleet overview, the
// per runs-on label set breakdown and the per label demand, so that every output format
// describes the same collection.
type ExportReport struct {
	Window  Window
	Repos   []string
	Summary Summary
	Pools   []QueueRow
	Labels  []LabelRow
}

// BuildExportReport assembles the report from a single collection.
func BuildExportReport(data *Data) ExportReport {
	repos := make([]string, 0, len(data.Repos))
	for _, repo := range data.Repos {
		repos = append(repos, repo.Owner+"/"+repo.Name)
	}

	return ExportReport{
		Window:  data.Window,
		Repos:   repos,
		Summary: BuildSummary(data),
		Pools:   BuildQueueStats(data),
		Labels:  BuildLabelStats(data, false),
	}
}
