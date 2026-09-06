package kitutil

import (
	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/google/go-github/v90/github"
	"github.com/spf13/cobra"
	runnerpkg "github.com/srz-zumix/gh-runner-kit/pkg/runner"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

const cordonedField = "CORDONED"

// groupField is dropped because the runner list APIs do not return runner_group_id.
const groupField = "GROUP"

var defaultFields = []string{"ID", "NAME", "OS", "STATUS", "BUSY", cordonedField, "LABELS"}

// RunnerFieldGetters returns the runner field getters extended with the cordon status column.
func RunnerFieldGetters() *render.RunnerFieldGetters {
	getters := render.NewRunnerFieldGetters()
	delete(getters.Func, groupField)
	getters.Func[cordonedField] = func(runner *github.Runner) string {
		return render.ToString(github.Ptr(runnerpkg.IsCordoned(runner)))
	}
	return getters
}

// AddFieldsFlag registers the --fields flag along with its shell completion.
func AddFieldsFlag(cmd *cobra.Command, fields *[]string) {
	cmdutil.StringSliceEnumFlag(cmd, fields, "fields", "", nil, RunnerFieldGetters().Fields(), "Table columns to display")
}

// FieldHeaders returns the table headers to render, falling back to the default columns.
func FieldHeaders(fields []string) []string {
	if len(fields) == 0 {
		return defaultFields
	}
	return fields
}
