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
		{OS: "ZERO_DURATION", Jobs: 1},
	}
	if err := RenderMetricsCost(r, rows); err != nil {
		t.Fatalf("RenderMetricsCost() error = %v", err)
	}

	output := stdout.String()
	if !strings.Contains(output, "1m0s") {
		t.Errorf("RenderMetricsCost() did not show positive billable time:\n%s", output)
	}
	if !strings.Contains(output, "0s") {
		t.Errorf("RenderMetricsCost() did not show measured zero billable time:\n%s", output)
	}
}
