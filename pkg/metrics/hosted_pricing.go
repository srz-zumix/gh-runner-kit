package metrics

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"github.com/google/go-github/v90/github"
)

//go:embed hosted_prices.json
var hostedPricesJSON []byte

type runnerSpec struct {
	SKU            string   `json:"sku"`
	OS             string   `json:"os"`
	Architecture   string   `json:"architecture"`
	CPU            int      `json:"cpu"`
	MemoryGB       int      `json:"memoryGB"`
	StorageGB      int      `json:"storageGB"`
	PublicCPU      int      `json:"publicCPU"`
	PublicMemoryGB int      `json:"publicMemoryGB"`
	Labels         []string `json:"labels"`
}

type hostedPriceCatalog struct {
	Source      string             `json:"source"`
	Version     string             `json:"version"`
	Rates       map[string]float64 `json:"rates"`
	Standard    []runnerSpec       `json:"standard"`
	MacosLarger []runnerSpec       `json:"macosLarger"`
}

var hostedPrices = func() hostedPriceCatalog {
	var catalog hostedPriceCatalog
	if err := json.Unmarshal(hostedPricesJSON, &catalog); err != nil {
		panic(fmt.Sprintf("invalid embedded hosted pricing catalog: %v", err))
	}
	return catalog
}()

// HostedPrice identifies the inferred billing SKU and the current machine specification.
// A nil Rate means that automatic pricing was not possible, not that execution was free.
type HostedPrice struct {
	OS           string
	SKU          string
	RunnerClass  string
	Architecture string
	CPUCores     int
	MemoryGB     int
	StorageGB    int
	Larger       bool
	Excluded     bool
	Rate         *float64
	Source       string
	Reason       string
}

var machineSizePattern = regexp.MustCompile(`^([0-9]+)-core(?:-(arm|arm64|gpu))?$`)

// PriceHostedJob matches a pool by its workflow label, never by a job's ephemeral runner ID.
func PriceHostedJob(job *github.WorkflowJob, inventory []*github.HostedRunner, selfHostedIDs map[int64]bool, public *bool, overrides map[string]float64) HostedPrice {
	labels := make([]string, len(job.Labels))
	for i, label := range job.Labels {
		labels[i] = strings.ToLower(label)
	}
	p := HostedPrice{OS: "UNKNOWN", RunnerClass: "Unknown runner", Reason: "runner hardware could not be identified"}
	if selfHostedIDs[job.GetRunnerID()] || slices.Contains(labels, selfHostedLabel) {
		p.Excluded, p.Source, p.Reason = true, "self-hosted", ""
		return p
	}

	var matches []*github.HostedRunner
	for _, runner := range inventory {
		if slices.Contains(labels, strings.ToLower(runner.GetName())) {
			matches = append(matches, runner)
		}
	}
	if len(matches) > 0 {
		if len(matches) != 1 || (job.GetRunnerGroupID() != 0 && job.GetRunnerGroupID() != matches[0].GetRunnerGroupID()) {
			p.Reason = "hosted pool label or runner group is ambiguous"
			return p
		}
		p = priceHostedPool(matches[0])
	} else {
		var specs []runnerSpec
		larger := false
		for _, spec := range append(slices.Clone(hostedPrices.Standard), hostedPrices.MacosLarger...) {
			if slices.ContainsFunc(spec.Labels, func(label string) bool { return slices.Contains(labels, label) }) {
				specs = append(specs, spec)
			}
		}
		if len(specs) == 1 && (job.GetRunnerGroupName() == "" || strings.EqualFold(job.GetRunnerGroupName(), hostedRunnerGroup)) {
			spec := specs[0]
			larger = !strings.HasPrefix(spec.SKU, "actions_")
			if !larger && spec.PublicCPU > 0 {
				if public == nil {
					spec.CPU, spec.MemoryGB = 0, 0
				} else if *public {
					spec.CPU, spec.MemoryGB = spec.PublicCPU, spec.PublicMemoryGB
				}
			}
			p = HostedPrice{OS: spec.OS, SKU: spec.SKU, Architecture: spec.Architecture, CPUCores: spec.CPU, MemoryGB: spec.MemoryGB, StorageGB: spec.StorageGB, Larger: larger, Source: "workflow label"}
		} else {
			for _, label := range labels {
				switch {
				case strings.HasPrefix(label, "ubuntu-"):
					p.OS = "UBUNTU"
				case strings.HasPrefix(label, "windows-"):
					p.OS = "WINDOWS"
				case strings.HasPrefix(label, "macos-"):
					p.OS = "MACOS"
				}
			}
		}
	}
	p.RunnerClass = p.SKU
	if p.RunnerClass == "" {
		p.RunnerClass = p.OS + " (unknown hardware)"
	}
	rate, known := hostedPrices.Rates[p.SKU]
	if override, ok := overrides[strings.ToUpper(p.SKU)]; p.SKU != "" && ok {
		rate, known, p.Source = override, true, "SKU override"
	} else if override, ok := overrides[p.OS]; ok && p.OS != "UNKNOWN" {
		rate, known, p.Source = override, true, "OS override"
	}
	if known {
		switch {
		case strings.HasPrefix(p.SKU, "actions_") && public == nil:
			p.Reason = "repository visibility is unavailable"
		case strings.HasPrefix(p.SKU, "actions_") && *public:
			p.Rate, p.Reason = github.Ptr(0.0), ""
			p.Source += "; public standard runner is free"
		default:
			p.Rate, p.Reason = &rate, ""
		}
	}
	return p
}

func priceHostedPool(runner *github.HostedRunner) HostedPrice {
	size := runner.GetMachineSizeDetails()
	p := HostedPrice{OS: "UNKNOWN", Larger: true, Source: "current hosted pool", Reason: "unsupported hosted machine size or platform"}
	if size == nil {
		return p
	}
	p.CPUCores, p.MemoryGB, p.StorageGB = size.CPUCores, size.MemoryGB, size.StorageGB
	platform := strings.ToLower(runner.GetPlatform())
	var os string
	switch platform {
	case "linux-x64", "linux-arm64":
		p.OS, os = "UBUNTU", "linux"
	case "win-x64", "win-arm64", "windows-x64", "windows-arm64":
		p.OS, os = "WINDOWS", "windows"
	case "mac-x64", "mac-arm64", "macos-x64", "macos-arm64":
		p.OS, os = "MACOS", "macos"
	default:
		return p
	}
	id := strings.ToLower(size.ID)
	match := machineSizePattern.FindStringSubmatch(id)
	if match == nil || match[1] != fmt.Sprint(size.CPUCores) {
		return p
	}
	p.Architecture = "x64"
	suffix := ""
	if match[2] == "gpu" {
		suffix = "_gpu"
	} else if match[2] == "arm" || match[2] == "arm64" || strings.Contains(platform, "arm64") {
		p.Architecture, suffix = "arm64", "_arm"
	}
	p.SKU = fmt.Sprintf("%s_%d_core%s", os, size.CPUCores, suffix)
	if os == "linux" && size.CPUCores == 2 && suffix == "" {
		p.SKU = "linux_2_core_advanced"
	}
	if os == "macos" {
		switch {
		case size.CPUCores == 12 && suffix == "":
			p.SKU = "macos_l"
		case size.CPUCores == 5 && suffix == "_arm":
			p.SKU = "macos_xl"
		}
	}
	return p
}
