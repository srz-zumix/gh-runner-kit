package kitutil

import (
	"fmt"

	"github.com/spf13/cobra"
)

// ValidateSelector rejects selector flags that were explicitly provided but whose
// values collapse to the "unset" sentinel used by runner.SelectOptions (ID == 0,
// empty name/label). Cobra's required-flag check is satisfied whenever a flag is
// set, so without this validation values such as "--id 0" or an empty "--name"
// would surface a misleading "no runner selected" error.
func ValidateSelector(cmd *cobra.Command, id int64, name, label string) error {
	if cmd.Flags().Changed("id") && id <= 0 {
		return fmt.Errorf("runner ID must be positive")
	}
	if cmd.Flags().Changed("name") && name == "" {
		return fmt.Errorf("runner name must not be empty")
	}
	if cmd.Flags().Changed("label") && label == "" {
		return fmt.Errorf("runner label must not be empty")
	}
	return nil
}
