package metrics

import (
	"math"
	"testing"
	"time"
)

func TestErlangC(t *testing.T) {
	tests := []struct {
		name    string
		servers int
		load    float64
		want    float64
	}{
		{name: "no load never queues", servers: 2, load: 0, want: 0},
		{name: "pool smaller than the load always queues", servers: 2, load: 3, want: 1},
		{name: "pool equal to the load always queues", servers: 2, load: 2, want: 1},
		{name: "no runners always queue", servers: 0, load: 1, want: 1},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ErlangC(tt.servers, tt.load); got != tt.want {
				t.Errorf("ErlangC(%d, %v) = %v, want %v", tt.servers, tt.load, got, tt.want)
			}
		})
	}
}

func TestErlangCDecreasesWithMoreRunners(t *testing.T) {
	previous := math.Inf(1)
	for servers := 2; servers <= 10; servers++ {
		got := ErlangC(servers, 1.5)
		if got >= previous {
			t.Fatalf("ErlangC(%d, 1.5) = %v, want less than %v", servers, got, previous)
		}
		previous = got
	}
}

func TestErlangWait(t *testing.T) {
	if _, ok := ErlangWait(2, 2, time.Minute); ok {
		t.Fatal("ErlangWait() reported a mean for a pool that cannot keep up with the load")
	}

	wait, ok := ErlangWait(4, 2, 10*time.Minute)
	if !ok {
		t.Fatal("ErlangWait() = not ok, want a mean for a pool larger than the load")
	}
	if wait <= 0 {
		t.Fatalf("ErlangWait() = %v, want a positive wait", wait)
	}

	// Adding a runner can only shorten the queue.
	shorter, _ := ErlangWait(5, 2, 10*time.Minute)
	if shorter >= wait {
		t.Fatalf("ErlangWait(5) = %v, want less than ErlangWait(4) = %v", shorter, wait)
	}
}

func TestRequiredRunners(t *testing.T) {
	tests := []struct {
		name              string
		load              float64
		service           time.Duration
		targetWait        time.Duration
		targetUtilization float64
		want              int
	}{
		{name: "no load needs no runners", load: 0, service: time.Minute, targetWait: time.Minute, targetUtilization: 0.7, want: 0},
		{
			name: "the utilization target dominates a generous wait target",
			// A load of 2.0 at 70% utilization needs ceil(2/0.7) = 3 runners, and a ten
			// minute target is easily met at that size.
			load: 2, service: 10 * time.Minute, targetWait: 10 * time.Minute, targetUtilization: 0.7, want: 3,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got, _ := RequiredRunners(tt.load, tt.service, tt.targetWait, tt.targetUtilization); got != tt.want {
				t.Errorf("RequiredRunners() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestRequiredRunnersMeetsTheTarget(t *testing.T) {
	load, service, target := 3.0, 5*time.Minute, 30*time.Second

	servers, met := RequiredRunners(load, service, target, DefaultTargetUtilization)
	if !met {
		t.Fatalf("RequiredRunners() reported the target unmet for a satisfiable load")
	}
	wait, ok := ErlangWait(servers, load, service)
	if !ok || wait > target {
		t.Fatalf("RequiredRunners() = %d, whose wait is %v (ok=%v), want at most %v", servers, wait, ok, target)
	}
	if previous, ok := ErlangWait(servers-1, load, service); ok && previous <= target {
		t.Fatalf("RequiredRunners() = %d, but %d already meets the target with %v", servers, servers-1, previous)
	}
}

func TestRequiredRunnersStricterTargetNeedsMore(t *testing.T) {
	load, service := 3.0, 5*time.Minute

	lenient, _ := RequiredRunners(load, service, time.Minute, DefaultTargetUtilization)
	strict, _ := RequiredRunners(load, service, time.Second, DefaultTargetUtilization)
	if strict < lenient {
		t.Fatalf("RequiredRunners(1s) = %d, want at least RequiredRunners(1m) = %d", strict, lenient)
	}
}

// TestRequiredRunnersCapsUnsatisfiableLoad checks that a load past MaxRecommendedRunners
// returns the cap flagged as unmet, so a capped recommendation is never read as verified.
func TestRequiredRunnersCapsUnsatisfiableLoad(t *testing.T) {
	servers, met := RequiredRunners(MaxRecommendedRunners+5, time.Minute, time.Minute, DefaultTargetUtilization)
	if servers != MaxRecommendedRunners {
		t.Fatalf("RequiredRunners() = %d, want the cap %d", servers, MaxRecommendedRunners)
	}
	if met {
		t.Fatal("RequiredRunners() reported the target met for a load beyond the cap")
	}
}

func TestValidateCapacityTargets(t *testing.T) {
	tests := []struct {
		name        string
		wait        time.Duration
		utilization float64
		wantErr     bool
	}{
		{name: "valid", wait: time.Minute, utilization: 0.7},
		{name: "full utilization is allowed", wait: time.Minute, utilization: 1},
		{name: "zero wait", wait: 0, utilization: 0.7, wantErr: true},
		{name: "negative wait", wait: -time.Second, utilization: 0.7, wantErr: true},
		{name: "zero utilization", wait: time.Minute, utilization: 0, wantErr: true},
		{name: "utilization above one", wait: time.Minute, utilization: 1.5, wantErr: true},
		{name: "NaN utilization", wait: time.Minute, utilization: math.NaN(), wantErr: true},
		{name: "positive infinity utilization", wait: time.Minute, utilization: math.Inf(1), wantErr: true},
		{name: "negative infinity utilization", wait: time.Minute, utilization: math.Inf(-1), wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateCapacityTargets(tt.wait, tt.utilization)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateCapacityTargets() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestBuildCapacityStats(t *testing.T) {
	rows := BuildCapacityStats(testData(), DefaultTargetWait, DefaultTargetUtilization)

	if len(rows) != 1 {
		t.Fatalf("len(BuildCapacityStats()) = %d, want 1 (every fleet job shares one label set)", len(rows))
	}

	row := rows[0]
	if got, want := row.LabelSet(), "linux,self-hosted"; got != want {
		t.Fatalf("LabelSet() = %q, want %q", got, want)
	}
	if got, want := row.Jobs, 3; got != want {
		t.Fatalf("Jobs = %d, want %d", got, want)
	}
	// 30 minutes of busy time over a one hour window.
	if got, want := row.Load, 0.5; got != want {
		t.Fatalf("Load = %v, want %v", got, want)
	}
	if got, want := row.AvgDuration, 10*time.Minute; got != want {
		t.Fatalf("AvgDuration = %v, want %v", got, want)
	}
	if got, want := row.Runners, 3; got != want {
		t.Fatalf("Runners = %d, want %d", got, want)
	}
	if row.Recommended <= 0 {
		t.Fatalf("Recommended = %d, want a positive pool for a non-zero load", row.Recommended)
	}
	if got, want := row.Delta, row.Recommended-row.Runners; got != want {
		t.Fatalf("Delta = %d, want %d", got, want)
	}
}

func TestBuildCapacityStatsExcludesHostedJobs(t *testing.T) {
	for _, row := range BuildCapacityStats(testData(), DefaultTargetWait, DefaultTargetUtilization) {
		for _, label := range row.Labels {
			if label == "ubuntu-latest" {
				t.Fatalf("BuildCapacityStats() reported a hosted label set: %+v", row)
			}
		}
	}
}
