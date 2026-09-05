package cmd

import "github.com/spf13/cobra"

var runnerCmd = &cobra.Command{
	Use:   "runner",
	Short: "Runner-related command group",
	Long:  `Runner-related command group`,
}

func init() {
	rootCmd.AddCommand(runnerCmd)
}
