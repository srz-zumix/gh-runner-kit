package runner

import (
	"reflect"
	"testing"

	"github.com/google/go-github/v90/github"
)

func TestSelectOptionsValidate(t *testing.T) {
	cases := []struct {
		name    string
		opts    SelectOptions
		wantErr bool
	}{
		{"none", SelectOptions{}, true},
		{"id", SelectOptions{ID: 5}, false},
		{"name", SelectOptions{Name: "runner-1"}, false},
		{"label", SelectOptions{Label: "gpu"}, false},
		{"id and name", SelectOptions{ID: 5, Name: "runner-1"}, true},
		{"name and label", SelectOptions{Name: "runner-1", Label: "gpu"}, true},
		{"all three", SelectOptions{ID: 5, Name: "runner-1", Label: "gpu"}, true},
		{"negative id", SelectOptions{ID: -1}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.opts.validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("validate() error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}

func label(name, typ string) *github.RunnerLabels {
	return &github.RunnerLabels{Name: github.Ptr(name), Type: github.Ptr(typ)}
}

func TestBuildCordonLabels(t *testing.T) {
	runner := &github.Runner{
		Labels: []*github.RunnerLabels{
			label("self-hosted", "read-only"),
			label("linux", "read-only"),
			label("gpu", "custom"),
			label("fast", "custom"),
		},
	}

	got := buildCordonLabels(runner, "cordoned-")
	want := []string{CordonMarkerLabel, "cordoned-gpu", "cordoned-fast"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("buildCordonLabels() = %v, want %v", got, want)
	}
}

func TestParseCordonedLabels(t *testing.T) {
	t.Run("group and custom labels restored", func(t *testing.T) {
		runner := &github.Runner{
			Labels: []*github.RunnerLabels{
				label(CordonMarkerLabel, "custom"),
				label(CordonGroupLabelPrefix+"42", "custom"),
				label("cordoned-gpu", "custom"),
				label("self-hosted", "read-only"),
			},
		}

		gotLabels, gotGroup := parseCordonedLabels(runner, "cordoned-")
		if gotGroup != 42 {
			t.Errorf("restoredGroupID = %d, want 42", gotGroup)
		}
		if want := []string{"gpu"}; !reflect.DeepEqual(gotLabels, want) {
			t.Errorf("restoredLabels = %v, want %v", gotLabels, want)
		}
	})

	t.Run("no group marker yields -1", func(t *testing.T) {
		runner := &github.Runner{
			Labels: []*github.RunnerLabels{
				label(CordonMarkerLabel, "custom"),
				label("cordoned-gpu", "custom"),
			},
		}

		gotLabels, gotGroup := parseCordonedLabels(runner, "cordoned-")
		if gotGroup != -1 {
			t.Errorf("restoredGroupID = %d, want -1", gotGroup)
		}
		if want := []string{"gpu"}; !reflect.DeepEqual(gotLabels, want) {
			t.Errorf("restoredLabels = %v, want %v", gotLabels, want)
		}
	})

	t.Run("group marker checked before label prefix", func(t *testing.T) {
		// CordonGroupLabelPrefix ("cordoned-group-") also matches labelPrefix
		// ("cordoned-"), so it must be classified as a group marker, not a label.
		runner := &github.Runner{
			Labels: []*github.RunnerLabels{
				label(CordonGroupLabelPrefix+"7", "custom"),
			},
		}

		gotLabels, gotGroup := parseCordonedLabels(runner, "cordoned-")
		if gotGroup != 7 {
			t.Errorf("restoredGroupID = %d, want 7", gotGroup)
		}
		if len(gotLabels) != 0 {
			t.Errorf("restoredLabels = %v, want empty", gotLabels)
		}
	})
}
