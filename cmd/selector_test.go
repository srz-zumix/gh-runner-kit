package cmd

import (
	"io"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// TestSelectorValidationWired proves both commands run selector validation
// before creating a client / calling the API, so an explicit "--id 0" fails fast.
func TestSelectorValidationWired(t *testing.T) {
	factories := map[string]func() *cobra.Command{
		"cordon":   NewCordonCmd,
		"uncordon": NewUncordonCmd,
	}
	for name, factory := range factories {
		t.Run(name, func(t *testing.T) {
			cmd := factory()
			cmd.SetArgs([]string{"--id", "0"})
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)

			err := cmd.Execute()
			if err == nil || !strings.Contains(err.Error(), "runner ID must be positive") {
				t.Fatalf("%s --id 0 error = %v, want \"runner ID must be positive\"", name, err)
			}
		})
	}
}
