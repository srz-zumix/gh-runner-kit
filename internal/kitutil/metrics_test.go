package kitutil

import (
	"strings"
	"testing"
	"time"
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
