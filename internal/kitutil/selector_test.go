package kitutil

import (
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

func newSelectorFlagCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "test"}
	var (
		id           int64
		name, labelV string
	)
	cmd.Flags().Int64Var(&id, "id", 0, "")
	cmd.Flags().StringVar(&name, "name", "", "")
	cmd.Flags().StringVar(&labelV, "label", "", "")
	return cmd
}

func TestValidateSelector(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		wantErr string
	}{
		{"valid id", []string{"--id", "5"}, ""},
		{"valid name", []string{"--name", "runner-1"}, ""},
		{"valid label", []string{"--label", "gpu"}, ""},
		{"unset", nil, ""},
		{"explicit id zero", []string{"--id", "0"}, "runner ID must be positive"},
		{"negative id", []string{"--id", "-1"}, "runner ID must be positive"},
		{"explicit empty name", []string{"--name", ""}, "runner name must not be empty"},
		{"explicit empty label", []string{"--label", ""}, "runner label must not be empty"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cmd := newSelectorFlagCmd()
			if err := cmd.ParseFlags(tc.args); err != nil {
				t.Fatalf("ParseFlags(%v) error: %v", tc.args, err)
			}
			id, _ := cmd.Flags().GetInt64("id")
			name, _ := cmd.Flags().GetString("name")
			labelV, _ := cmd.Flags().GetString("label")

			err := ValidateSelector(cmd, id, name, labelV)
			switch {
			case tc.wantErr == "" && err != nil:
				t.Fatalf("unexpected error: %v", err)
			case tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)):
				t.Fatalf("error = %v, want containing %q", err, tc.wantErr)
			}
		})
	}
}
