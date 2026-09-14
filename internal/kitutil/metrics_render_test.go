package kitutil

import (
	"strings"
	"testing"
	"time"

	"github.com/cli/cli/v2/pkg/iostreams"
	"github.com/srz-zumix/gh-runner-kit/pkg/metrics"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func TestRenderMetricsCostShowsMeasuredBillableDurations(t *testing.T) {
	streams, _, stdout, _ := iostreams.Test()
	r := render.NewRenderer(nil)
	r.IO = streams

	rows := []metrics.CostRow{
		{OS: "RECORDED_WITHOUT_JOBS", Billable: time.Minute},
		{OS: "ZERO_DURATION"},
	}
	if err := RenderMetricsCost(r, rows); err != nil {
		t.Fatalf("RenderMetricsCost() error = %v", err)
	}

	output := stdout.String()
	if got, want := costRowFields(t, output, "RECORDED_WITHOUT_JOBS")[3], "1m0s"; got != want {
		t.Errorf("RECORDED_WITHOUT_JOBS billable = %q, want %q", got, want)
	}
	if got, want := costRowFields(t, output, "ZERO_DURATION")[3], "0s"; got != want {
		t.Errorf("ZERO_DURATION billable = %q, want %q", got, want)
	}
}

func costRowFields(t *testing.T, output, os string) []string {
	t.Helper()
	replacer := strings.NewReplacer("│", " ", "|", " ")
	for _, line := range strings.Split(output, "\n") {
		fields := strings.Fields(replacer.Replace(line))
		if len(fields) == 6 && fields[0] == os {
			return fields
		}
	}
	t.Fatalf("no %s row in output:\n%s", os, output)
	return nil
}
