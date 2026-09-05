package cmd

import (
	"bytes"
	"strings"
	"testing"
)

func TestRootHelp(t *testing.T) {
	buf := new(bytes.Buffer)
	rootCmd.SetOut(buf)
	rootCmd.SetErr(buf)
	rootCmd.SetArgs([]string{"--help"})

	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("Execute() returned error: %v", err)
	}

	out := buf.String()
	if !strings.Contains(out, "gh-runner-kit") {
		t.Fatalf("help output did not contain command name: %q", out)
	}
	if !strings.Contains(out, "Runner-related operations extension for GitHub CLI") {
		t.Fatalf("help output did not contain description: %q", out)
	}
}
