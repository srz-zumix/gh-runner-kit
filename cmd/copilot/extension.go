package copilot

import (
	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/version"
	"github.com/srz-zumix/go-gh-extension/pkg/copilotext"
)

const actionsMetricsExtensionURL = "https://github.com/srz-zumix/gh-runner-kit/tree/main/.github/extensions/actions-metrics"

// NewExtensionCmd creates the command for managing bundled Copilot CLI canvas extensions.
func NewExtensionCmd() *cobra.Command {
	return copilotext.NewExtensionCmd(copilotext.Config{
		ToolName:    "gh-runner-kit",
		ToolVersion: version.Version,
		Extensions: []copilotext.Extension{
			{
				Name: "actions-metrics",
				URL:  actionsMetricsExtensionURL,
			},
		},
	})
}
