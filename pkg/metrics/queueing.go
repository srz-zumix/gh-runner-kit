package metrics

import (
	"math"
	"time"
)

// MaxRecommendedRunners bounds the search RequiredRunners performs, so a pool whose
// demand cannot be met with a sane fleet size fails fast instead of looping.
const MaxRecommendedRunners = 10_000

// DefaultTargetUtilization is the share of the time a runner may be busy before the
// pool is considered too small. Queue time grows sharply above it.
const DefaultTargetUtilization = 0.7

// DefaultTargetWait is the mean queue time the recommended fleet size aims for.
const DefaultTargetWait = time.Minute

// erlangB returns the blocking probability of an M/M/c/c system by the recurrence
// B(k) = a*B(k-1) / (k + a*B(k-1)), which avoids the overflow of the factorial form.
func erlangB(servers int, load float64) float64 {
	b := 1.0
	for k := 1; k <= servers; k++ {
		b = load * b / (float64(k) + load*b)
	}
	return b
}

// ErlangC returns the probability that an arriving job finds every runner busy and has
// to queue, for a pool of the given size under the given offered load. A pool that is
// not larger than its load can never drain, so the probability is 1.
func ErlangC(servers int, load float64) float64 {
	if load <= 0 {
		return 0
	}
	if servers <= 0 || float64(servers) <= load {
		return 1
	}

	b := erlangB(servers, load)
	rho := load / float64(servers)
	return b / (1 - rho*(1-b))
}

// ErlangWait returns the mean queue time of an M/M/c pool, where service is the mean
// time a job occupies a runner. It reports false when the pool cannot keep up with the
// load, in which case the queue grows without bound and no mean exists.
func ErlangWait(servers int, load float64, service time.Duration) (time.Duration, bool) {
	if servers <= 0 || float64(servers) <= load {
		return 0, false
	}
	if load <= 0 || service <= 0 {
		return 0, true
	}

	wait := ErlangC(servers, load) * float64(service) / (float64(servers) - load)
	return time.Duration(wait), true
}

// RequiredRunners returns the smallest pool that keeps both the mean queue time at or
// below targetWait and the utilization at or below targetUtilization, given the offered
// load and the mean service time. The result is capped at MaxRecommendedRunners.
func RequiredRunners(load float64, service, targetWait time.Duration, targetUtilization float64) int {
	if load <= 0 {
		return 0
	}

	servers := 1
	if targetUtilization > 0 {
		servers = int(math.Ceil(load / targetUtilization))
	}
	// The queue only drains while the pool is strictly larger than the load.
	servers = max(servers, int(math.Floor(load))+1)

	for ; servers < MaxRecommendedRunners; servers++ {
		wait, ok := ErlangWait(servers, load, service)
		if ok && wait <= targetWait {
			return servers
		}
	}
	return MaxRecommendedRunners
}
