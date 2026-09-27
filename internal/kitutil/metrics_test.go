package kitutil

import (
	"context"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/spf13/cobra"
	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
)

func TestResolveConcurrency(t *testing.T) {
	tests := []struct {
		name      string
		bucket    string
		wantErr   string
		wantWidth time.Duration
	}{
		{name: "malformed duration", bucket: "notaduration", wantErr: "failed to parse --bucket"},
		{name: "non-positive width", bucket: "0", wantErr: "--bucket must be greater than 0"},
		{name: "negative width", bucket: "-1h", wantErr: "--bucket must be greater than 0"},
		{name: "too many buckets", bucket: "1ns", wantErr: "invalid --bucket"},
		{name: "valid", bucket: "1h", wantWidth: time.Hour},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			flags := MetricsFlags{Days: 7}
			window, width, err := flags.ResolveConcurrency(tt.bucket)

			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("ResolveConcurrency(%q) error = nil, want %q", tt.bucket, tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("ResolveConcurrency(%q) error = %q, want it to contain %q", tt.bucket, err, tt.wantErr)
				}
				return
			}

			if err != nil {
				t.Fatalf("ResolveConcurrency(%q) error = %v, want nil", tt.bucket, err)
			}
			if width != tt.wantWidth {
				t.Fatalf("ResolveConcurrency(%q) width = %v, want %v", tt.bucket, width, tt.wantWidth)
			}
			if !window.End.After(window.Start) {
				t.Fatalf("ResolveConcurrency(%q) window = %+v, want a positive span", tt.bucket, window)
			}
		})
	}
}

func TestResolveMetricsStepSummary(t *testing.T) {
	t.Setenv(MetricsStepSummaryEnv, "/tmp/summary.md")

	if got, err := ResolveMetricsStepSummary(false); err != nil || got != "" {
		t.Fatalf("ResolveMetricsStepSummary(false) = %q, %v, want empty path and nil error", got, err)
	}
	if got, err := ResolveMetricsStepSummary(true); err != nil || got != "/tmp/summary.md" {
		t.Fatalf("ResolveMetricsStepSummary(true) = %q, %v, want configured path and nil error", got, err)
	}

	t.Setenv(MetricsStepSummaryEnv, "")
	if _, err := ResolveMetricsStepSummary(true); err == nil {
		t.Fatal("ResolveMetricsStepSummary(true) error = nil, want an error without GITHUB_STEP_SUMMARY")
	}
}

func TestMetricsFlagsInputRejectsCollectionFlags(t *testing.T) {
	tests := []struct {
		name string
		args []string
	}{
		{name: "repo", args: []string{"--input", "snap.json", "--repo", "octo/hello"}},
		{name: "owner", args: []string{"--input", "snap.json", "--owner", "octo"}},
		{name: "days", args: []string{"--input", "snap.json", "--days", "1"}},
		{name: "since", args: []string{"--input", "snap.json", "--since", "2026-01-01"}},
		{name: "no-cache", args: []string{"--input", "snap.json", "--no-cache"}},
		{name: "refresh", args: []string{"--input", "snap.json", "--refresh"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var flags MetricsFlags
			cmd := &cobra.Command{Use: "test", RunE: func(*cobra.Command, []string) error { return nil }}
			flags.Add(cmd)
			cmd.SetArgs(tt.args)
			cmd.SetOut(io.Discard)
			cmd.SetErr(io.Discard)

			if err := cmd.Execute(); err == nil {
				t.Fatalf("Execute(%v) error = nil, want an error combining --input with --%s", tt.args, tt.name)
			}
		})
	}
}

func TestMetricsFlagsInputAllowsDefaults(t *testing.T) {
	var flags MetricsFlags
	cmd := &cobra.Command{Use: "test", RunE: func(*cobra.Command, []string) error { return nil }}
	flags.Add(cmd)
	cmd.SetArgs([]string{"--input", "snap.json"})
	cmd.SetOut(io.Discard)
	cmd.SetErr(io.Discard)

	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute([--input]) error = %v, want nil", err)
	}
}

func TestMetricsFlagsWindowFromSnapshot(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	want := metrics.Window{
		Start: time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
		End:   time.Date(2026, 8, 8, 0, 0, 0, 0, time.UTC),
	}
	snap := &metrics.Snapshot{
		Version:  metrics.CurrentSnapshotVersion,
		Contents: metrics.SnapshotContents{Jobs: true},
		Data:     &metrics.Data{Window: want},
	}
	if err := metrics.WriteSnapshot(path, snap); err != nil {
		t.Fatalf("WriteSnapshot: %v", err)
	}

	flags := MetricsFlags{Input: path}
	got, err := flags.Window()
	if err != nil {
		t.Fatalf("Window() error = %v", err)
	}
	if !got.Start.Equal(want.Start) || !got.End.Equal(want.End) {
		t.Fatalf("Window() = %+v, want %+v", got, want)
	}
}

func TestMetricsFlagsCollectRequiresSnapshotContents(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "snapshot.json")
	snap := &metrics.Snapshot{
		Version:  metrics.CurrentSnapshotVersion,
		Contents: metrics.SnapshotContents{},
		Data:     &metrics.Data{},
	}
	if err := metrics.WriteSnapshot(path, snap); err != nil {
		t.Fatalf("WriteSnapshot: %v", err)
	}

	flags := MetricsFlags{Input: path}
	cmd := &cobra.Command{}
	cmd.SetContext(context.Background())

	if _, err := flags.CollectWithWindow(cmd, metrics.Window{}); err == nil {
		t.Fatal("CollectWithWindow error = nil, want an error for a snapshot collected without jobs")
	}
	if _, err := flags.CollectUsage(cmd); err == nil {
		t.Fatal("CollectUsage error = nil, want an error for a snapshot collected without usage")
	}
}
