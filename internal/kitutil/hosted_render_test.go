package kitutil

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cli/cli/v2/pkg/cmdutil"
	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/render"
)

func TestRenderHostedRunners(t *testing.T) {
	runners := []*github.HostedRunner{{
		ID: github.Ptr(int64(42)), Name: github.Ptr("linux-large"),
		Platform: github.Ptr("linux-x64"), Status: github.Ptr("Ready"),
		RunnerGroupID: github.Ptr(int64(7)), MaximumRunners: github.Ptr(int64(10)),
		PublicIPEnabled: github.Ptr(false),
	}}
	for _, test := range []struct {
		name   string
		fields []string
		want   []string
	}{
		{"default", nil, []string{"ID", "NAME", "PLATFORM", "STATUS", "GROUP", "MAXIMUM RUNNERS", "PUBLIC IP ENABLED", "42", "linux-large", "linux-x64", "Ready", "7", "10", "NO"}},
		{"selected", []string{"name", "id"}, []string{"NAME", "ID", "linux-large", "42"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := render.NewStringRenderer(nil)
			if err := RenderHostedRunners(&r.Renderer, runners, test.fields); err != nil {
				t.Fatal(err)
			}
			for _, want := range test.want {
				if !strings.Contains(r.Stdout.String(), want) {
					t.Errorf("output %q does not contain %q", r.Stdout.String(), want)
				}
			}
			if test.fields != nil && strings.Contains(r.Stdout.String(), "PLATFORM") {
				t.Error("unselected column was rendered")
			}
		})
	}
}

func TestRenderHostedRunnersEmpty(t *testing.T) {
	r := render.NewStringRenderer(nil)
	if err := RenderHostedRunners(&r.Renderer, nil, nil); err != nil {
		t.Fatal(err)
	}
	if got := r.Stdout.String(); got != "No GitHub-hosted runners.\n" {
		t.Fatalf("unexpected output: %q", got)
	}
}

func TestRenderHostedRunnersMissingFields(t *testing.T) {
	r := render.NewStringRenderer(nil)
	if err := RenderHostedRunners(&r.Renderer, []*github.HostedRunner{{}}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestRenderHostedRunnersJSON(t *testing.T) {
	r := render.NewStringRenderer(cmdutil.NewJSONExporter())
	runners := []*github.HostedRunner{{
		ID: github.Ptr(int64(42)), Name: github.Ptr("linux-large"),
		MaximumRunners: github.Ptr(int64(10)),
	}}
	if err := RenderHostedRunners(&r.Renderer, runners, []string{"NAME"}); err != nil {
		t.Fatal(err)
	}
	var got []*github.HostedRunner
	if err := json.Unmarshal(r.Stdout.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].GetID() != 42 || got[0].GetName() != "linux-large" || got[0].GetMaximumRunners() != 10 {
		t.Fatalf("unexpected JSON: %s", r.Stdout.String())
	}
}
