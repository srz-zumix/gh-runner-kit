/*
Copyright © 2025 srz_zumix
*/
package cmd

import (
	"os"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/version"
)

var rootCmd = &cobra.Command{
	Use:     "gh-runner-kit",
	Short:   "Runner-related operations extension for GitHub CLI",
	Long:    `Runner-related operations extension for GitHub CLI`,
	Version: version.Version,
}

func Execute() {
	if err := rootCmd.Execute(); err != nil {
		os.Exit(1)
	}
}
