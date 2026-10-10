package metrics

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	ghclient "github.com/srz-zumix/go-gh-extension/pkg/gh/client"
)

func TestCollectPricingPermissionsAndOwnerScope(t *testing.T) {
	for _, mode := range []string{"org", "user", "forbidden", "visibility missing", "rate limited", "unauthorized", "inherited", "inherited forbidden", "inherited rate limited"} {
		t.Run(mode, func(t *testing.T) {
			poolCalls, inheritedCalls := 0, 0
			withInherited := mode == "inherited" || mode == "inherited forbidden" || mode == "inherited rate limited"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/repos/octo/demo" {
					if mode == "visibility missing" {
						w.WriteHeader(http.StatusNotFound)
						_, _ = fmt.Fprint(w, `{"message":"Not Found"}`)
						return
					}
					ownerType := "Organization"
					if mode == "user" {
						ownerType = "User"
					}
					_, _ = fmt.Fprintf(w, `{"private":true,"owner":{"type":%q}}`, ownerType)
					return
				}
				if r.URL.Path == "/orgs/octo/actions/runner-groups" {
					if withInherited {
						_, _ = fmt.Fprint(w, `{"total_count":2,"runner_groups":[{"id":3,"inherited":true},{"id":4,"inherited":false}]}`)
					} else {
						_, _ = fmt.Fprint(w, `{"total_count":0,"runner_groups":[]}`)
					}
					return
				}
				if r.URL.Path == "/orgs/octo/actions/runner-groups/3/hosted-runners" {
					inheritedCalls++
					switch mode {
					case "inherited forbidden":
						w.WriteHeader(http.StatusForbidden)
						_, _ = fmt.Fprint(w, `{"message":"Forbidden"}`)
					case "inherited rate limited":
						w.Header().Set("X-RateLimit-Remaining", "0")
						w.Header().Set("X-RateLimit-Reset", fmt.Sprint(time.Now().Add(time.Hour).Unix()))
						w.WriteHeader(http.StatusForbidden)
						_, _ = fmt.Fprint(w, `{"message":"API rate limit exceeded"}`)
					default:
						_, _ = fmt.Fprint(w, `{"total_count":1,"runners":[{"id":900,"name":"ubuntu-latest-large","platform":"linux-x64","runner_group_id":3,"machine_size_details":{"id":"8-core","cpu_cores":8,"memory_gb":32,"storage_gb":300}}]}`)
					}
					return
				}
				if r.URL.Path != "/orgs/octo/actions/hosted-runners" {
					t.Errorf("unexpected path: %s", r.URL)
				}
				poolCalls++
				switch mode {
				case "forbidden":
					w.WriteHeader(http.StatusForbidden)
					_, _ = fmt.Fprint(w, `{"message":"Forbidden"}`)
				case "rate limited":
					w.Header().Set("X-RateLimit-Remaining", "0")
					w.Header().Set("X-RateLimit-Reset", fmt.Sprint(time.Now().Add(time.Hour).Unix()))
					w.WriteHeader(http.StatusForbidden)
					_, _ = fmt.Fprint(w, `{"message":"API rate limit exceeded"}`)
				case "unauthorized":
					w.WriteHeader(http.StatusUnauthorized)
					_, _ = fmt.Fprint(w, `{"message":"Unauthorized"}`)
				default:
					if withInherited {
						_, _ = fmt.Fprint(w, `{"total_count":0,"runners":[]}`)
					} else {
						_, _ = fmt.Fprint(w, `{"total_count":1,"runners":[{"id":900,"name":"pool","platform":"linux-x64","machine_size_details":{"id":"8-core","cpu_cores":8,"memory_gb":32,"storage_gb":300}}]}`)
					}
				}
			}))
			defer server.Close()
			base := server.URL + "/"
			api, err := github.NewClient(github.WithHTTPClient(server.Client()), github.WithURLs(&base, nil))
			if err != nil {
				t.Fatal(err)
			}
			client, err := ghclient.NewClient(api)
			if err != nil {
				t.Fatal(err)
			}
			c := NewCollector(client, repository.Repository{}, Options{}, nil)
			data := &Data{HostedRunners: map[string][]*github.HostedRunner{}, RepositoryPublic: map[string]bool{}}
			repo := repository.Repository{Host: "github.com", Owner: "octo", Name: "demo"}
			err = c.collectPricing(context.Background(), repo, data)
			if mode == "unauthorized" || mode == "rate limited" || mode == "inherited rate limited" {
				if err == nil {
					t.Fatal("expected a fatal authentication/rate-limit error, not a partial successful collection")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if mode == "user" && poolCalls != 0 {
				t.Fatal("user-owned repository requested organization pools")
			}
			if mode == "forbidden" || mode == "visibility missing" || mode == "inherited forbidden" {
				if len(data.Warnings) != 1 {
					t.Fatalf("warnings = %v", data.Warnings)
				}
			}
			if mode == "visibility missing" {
				if _, ok := data.RepositoryPublic["octo/demo"]; ok {
					t.Fatal("unavailable visibility was defaulted")
				}
			} else if value, ok := data.RepositoryPublic["octo/demo"]; !ok || value {
				t.Fatal("private repository visibility was not retained")
			}
			if mode == "inherited" {
				data.Jobs = []*github.WorkflowJob{{
					ID: github.Ptr(int64(1)), RunID: github.Ptr(int64(1)),
					RunnerID: github.Ptr(int64(1003372588)), RunnerGroupID: github.Ptr(int64(3)),
					Labels: []string{"ubuntu-latest-large"}, Status: github.Ptr("completed"),
				}}
				data.RunRepositories = map[int64]string{1: "octo/demo"}
				data.Usage = map[int64]*github.WorkflowRunUsage{1: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": detailedBill(61_000)})}
				rows, warnings := BuildCostStats(data, nil)
				if len(rows) != 1 || len(warnings) != 0 || rows[0].SKU != "linux_8_core" ||
					rows[0].CPUCores != 8 || rows[0].MemoryGB != 32 || rows[0].Rate == nil ||
					*rows[0].Rate != 0.022 || rows[0].Cost == nil || *rows[0].Cost != 0.044 {
					t.Fatalf("rows = %+v; warnings = %v", rows, warnings)
				}
			}
			if mode != "visibility missing" {
				if err := c.collectPricing(context.Background(), repo, data); err != nil {
					t.Fatal(err)
				}
				if mode != "user" && poolCalls != 1 {
					t.Fatal("hosted inventory was re-fetched for the same owner")
				}
				if withInherited && inheritedCalls != 1 {
					t.Fatalf("inherited inventory was read %d times, want once", inheritedCalls)
				}
			}
		})
	}
}

func TestCostUsesUsageWhenJobTimestampsAreUnavailable(t *testing.T) {
	data := &Data{
		Jobs:             []*github.WorkflowJob{{ID: github.Ptr(int64(1)), RunID: github.Ptr(int64(1)), Labels: []string{"ubuntu-latest"}, Status: github.Ptr("completed")}},
		RunRepositories:  map[int64]string{1: "octo/demo"},
		RepositoryPublic: map[string]bool{"octo/demo": false},
		Usage:            map[int64]*github.WorkflowRunUsage{1: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": detailedBill(61_000)})},
	}

	rows, warnings := BuildCostStats(data, nil)
	if len(rows) != 1 || len(warnings) != 0 || rows[0].Cost == nil || *rows[0].Cost != 0.012 || rows[0].Billable != 2*time.Minute {
		t.Fatalf("rows = %+v; warnings = %v", rows, warnings)
	}
}

func TestCostDoesNotReportFreeExecutionWhenCollectionIsMissing(t *testing.T) {
	data := &Data{Runs: []*github.WorkflowRun{{ID: github.Ptr(int64(1)), Status: github.Ptr("completed")}}}
	rows, warnings := BuildCostStats(data, nil)
	_, cost := CostTotal(rows)
	if len(rows) != 1 || cost != nil || len(warnings) < 1 {
		t.Fatalf("rows = %+v; total = %v; warnings = %v", rows, cost, warnings)
	}
}

func TestCostKeepsIncompleteUsageCoverageUnknown(t *testing.T) {
	billing := detailedBill(30_000)
	billing.Jobs = github.Ptr(3)
	data := &Data{
		Jobs:             []*github.WorkflowJob{testJob("build", 0, "", []string{"ubuntu-latest"}, "success", 0, 1, 2)},
		RunRepositories:  map[int64]string{1: "octo/demo"},
		RepositoryPublic: map[string]bool{"octo/demo": false},
		Usage:            map[int64]*github.WorkflowRunUsage{1: usageOf(map[string]*github.WorkflowRunBill{"UBUNTU": billing})},
	}
	data.Jobs[0].ID = github.Ptr(int64(1))
	rows, warnings := BuildCostStats(data, nil)
	_, cost := CostTotal(rows)
	var unpriced int
	for _, row := range rows {
		unpriced += row.UnpricedJobs
	}
	if cost != nil || unpriced != 2 || len(warnings) == 0 {
		t.Fatalf("rows = %+v; total = %v; unpriced = %d; warnings = %v", rows, cost, unpriced, warnings)
	}
}

func TestCostCountsUnmatchedDetailsWhenOtherOSUsageIsIncomplete(t *testing.T) {
	data := &Data{
		Jobs:             []*github.WorkflowJob{testJob("build", 0, "", []string{"ubuntu-latest"}, "success", 0, 1, 2)},
		RunRepositories:  map[int64]string{1: "octo/demo"},
		RepositoryPublic: map[string]bool{"octo/demo": false},
		Usage: map[int64]*github.WorkflowRunUsage{1: usageOf(map[string]*github.WorkflowRunBill{
			"UBUNTU":  detailedBill(30_000, 30_000),
			"WINDOWS": {Jobs: github.Ptr(1), TotalMS: github.Ptr(int64(30_000))},
		})},
	}
	data.Jobs[0].ID = github.Ptr(int64(1))
	rows, warnings := BuildCostStats(data, nil)
	_, cost := CostTotal(rows)
	var jobs, unpriced int
	for _, row := range rows {
		jobs += row.Jobs
		unpriced += row.UnpricedJobs
	}
	if cost != nil || jobs != 3 || unpriced != 2 || len(warnings) == 0 {
		t.Fatalf("rows = %+v; total = %v; jobs = %d; unpriced = %d; warnings = %v", rows, cost, jobs, unpriced, warnings)
	}
}
