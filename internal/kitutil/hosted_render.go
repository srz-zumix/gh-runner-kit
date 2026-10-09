package kitutil

import (
	"strings"

	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func HostedRunnerFields() []string {
	return []string{"GROUP", "ID", "MAXIMUM_RUNNERS", "NAME", "PLATFORM", "PUBLIC_IP_ENABLED", "STATUS"}
}

func RenderHostedRunners(r *render.Renderer, runners []*github.HostedRunner, fields []string) error {
	if r.HasExporter() {
		return r.RenderExportedData(runners)
	}
	if len(runners) == 0 {
		r.WriteLine("No GitHub-hosted runners.")
		return nil
	}
	if len(fields) == 0 {
		fields = []string{"ID", "NAME", "PLATFORM", "STATUS", "GROUP", "MAXIMUM_RUNNERS", "PUBLIC_IP_ENABLED"}
	}
	headers := make([]string, len(fields))
	for index, field := range fields {
		headers[index] = strings.ToUpper(field)
	}
	table := r.NewTableWriter(headers)
	for _, runner := range runners {
		values := map[string]string{
			"ID":                render.ToString(runner.ID),
			"NAME":              render.ToString(runner.Name),
			"PLATFORM":          render.ToString(runner.Platform),
			"STATUS":            render.ToString(runner.Status),
			"GROUP":             render.ToString(runner.RunnerGroupID),
			"MAXIMUM_RUNNERS":   render.ToString(runner.MaximumRunners),
			"PUBLIC_IP_ENABLED": render.ToString(runner.PublicIPEnabled),
		}
		row := make([]string, len(headers))
		for index, header := range headers {
			row[index] = values[header]
		}
		table.Append(row)
	}
	return table.Render()
}
