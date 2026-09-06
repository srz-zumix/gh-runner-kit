package runner

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/gh"
)

const (
	// CordonMarkerLabel is added to every cordoned runner.
	CordonMarkerLabel = "cordoned"
	// CordonGroupLabelPrefix records the runner group a cordoned runner came from.
	CordonGroupLabelPrefix = "cordoned-group-"
	// DefaultCordonGroupName is the isolated runner group used by the group strategy.
	DefaultCordonGroupName = "gh-runner-kit-cordoned"
)

// IsCordoned reports whether runner carries the cordon marker label.
func IsCordoned(runner *github.Runner) bool {
	return gh.HasRunnerLabel(runner, CordonMarkerLabel)
}

// SelectOptions specifies which runners a command operates on.
// Exactly one field is expected to be set.
type SelectOptions struct {
	ID    int64
	Name  string
	Label string
}

// validate enforces the "exactly one selector" invariant. It returns a clear
// error when zero or multiple selector fields are set, or when ID is negative.
func (o SelectOptions) validate() error {
	if o.ID < 0 {
		return fmt.Errorf("runner ID must be positive")
	}
	count := 0
	if o.ID != 0 {
		count++
	}
	if o.Name != "" {
		count++
	}
	if o.Label != "" {
		count++
	}
	switch count {
	case 0:
		return fmt.Errorf("no runner selected: set exactly one of id, name, or label")
	case 1:
		return nil
	default:
		return fmt.Errorf("exactly one of id, name, or label must be set")
	}
}

// Select returns the runners matching opts. Selecting by ID or name returns the
// single matching runner and fails when it does not exist, while selecting by
// label returns every runner carrying that label and may return an empty slice.
// Exactly one selector field must be set; otherwise an error is returned.
func Select(ctx context.Context, client *gh.GitHubClient, repo repository.Repository, opts SelectOptions) ([]*github.Runner, error) {
	if err := opts.validate(); err != nil {
		return nil, err
	}
	switch {
	case opts.ID != 0:
		runner, err := gh.GetRunner(ctx, client, repo, opts.ID)
		if err != nil {
			return nil, err
		}
		return []*github.Runner{runner}, nil
	case opts.Name != "":
		runner, err := gh.FindRunner(ctx, client, repo, opts.Name)
		if err != nil {
			return nil, err
		}
		if runner == nil {
			return nil, fmt.Errorf("runner %q not found", opts.Name)
		}
		return []*github.Runner{runner}, nil
	case opts.Label != "":
		return gh.FindRunnersByLabel(ctx, client, repo, opts.Label)
	}
	// Unreachable: validate guarantees exactly one selector is set.
	return nil, fmt.Errorf("no runner selected")
}

// CordonByGroup cordons runner by moving it into an isolated runner group,
// creating the group if it does not already exist. The original group ID is
// recorded as a label so it can be restored later.
func CordonByGroup(ctx context.Context, client *gh.GitHubClient, repo repository.Repository, runner *github.Runner, groupName, visibility string) error {
	group, err := gh.FindOrgRunnerGroup(ctx, client, repo, groupName)
	if err != nil {
		return err
	}
	if group == nil {
		group, err = gh.CreateOrgRunnerGroupWithRequest(ctx, client, repo, github.CreateRunnerGroupRequest{
			Name:                  github.Ptr(groupName),
			Visibility:            github.Ptr(visibility),
			SelectedRepositoryIDs: []int64{},
		})
		if err != nil {
			return err
		}
	}

	originalGroupID := runner.GetRunnerGroupID()
	if originalGroupID == 0 {
		// The runner APIs do not return runner_group_id, so walk the group membership instead.
		current, err := gh.FindOrgRunnerGroupByRunner(ctx, client, repo, runner.GetID())
		if err != nil {
			return err
		}
		if current != nil {
			originalGroupID = current.GetID()
		}
	}

	if _, err := gh.AddRunnerLabels(ctx, client, repo, runner.GetID(), []string{
		CordonMarkerLabel,
		fmt.Sprintf("%s%d", CordonGroupLabelPrefix, originalGroupID),
	}); err != nil {
		return err
	}

	return gh.AddOrgRunnerGroupRunner(ctx, client, repo, group.GetID(), runner.GetID())
}

// CordonByLabel cordons runner by renaming its custom labels with labelPrefix,
// leaving built-in read-only labels untouched.
func CordonByLabel(ctx context.Context, client *gh.GitHubClient, repo repository.Repository, runner *github.Runner, labelPrefix string) error {
	_, err := gh.SetRunnerLabels(ctx, client, repo, runner.GetID(), buildCordonLabels(runner, labelPrefix))
	return err
}

// buildCordonLabels returns the labels applied by CordonByLabel: the cordon
// marker label plus every custom (non read-only) label renamed with labelPrefix.
func buildCordonLabels(runner *github.Runner, labelPrefix string) []string {
	newLabels := make([]string, 0, len(runner.Labels)+1)
	newLabels = append(newLabels, CordonMarkerLabel)
	for _, l := range runner.Labels {
		if l.GetType() == "read-only" {
			continue
		}
		newLabels = append(newLabels, labelPrefix+l.GetName())
	}
	return newLabels
}

// Uncordon reverses a cordon operation, restoring the runner group and custom
// labels recorded by CordonByGroup / CordonByLabel.
// A recorded group ID of 0 means the original group could not be determined at
// cordon time, in which case the runner is returned to the default group.
func Uncordon(ctx context.Context, client *gh.GitHubClient, repo repository.Repository, runner *github.Runner, labelPrefix string) error {
	restoredLabels, restoredGroupID := parseCordonedLabels(runner, labelPrefix)

	if restoredGroupID == 0 {
		defaultGroup, err := gh.FindOrgDefaultRunnerGroup(ctx, client, repo)
		if err != nil {
			return err
		}
		if defaultGroup == nil {
			return fmt.Errorf("the original runner group of %s is unknown and no default runner group was found in %s", runner.GetName(), repo.Owner)
		}
		restoredGroupID = defaultGroup.GetID()
	}

	if restoredGroupID > 0 {
		if err := gh.AddOrgRunnerGroupRunner(ctx, client, repo, restoredGroupID, runner.GetID()); err != nil {
			return err
		}
	}

	_, err := gh.SetRunnerLabels(ctx, client, repo, runner.GetID(), restoredLabels)
	return err
}

// parseCordonedLabels inspects a cordoned runner's labels and returns the custom
// labels to restore together with the recorded original runner group ID. The
// group ID is -1 when no group marker label is present and 0 when the marker
// recorded the group as unknown. The cordon marker label is dropped and built-in
// read-only labels are left out (GitHub manages them automatically).
func parseCordonedLabels(runner *github.Runner, labelPrefix string) (restoredLabels []string, restoredGroupID int64) {
	restoredGroupID = -1
	restoredLabels = make([]string, 0, len(runner.Labels))
	for _, l := range runner.Labels {
		name := l.GetName()
		switch {
		case strings.EqualFold(name, CordonMarkerLabel):
			// marker label; drop it
		case strings.HasPrefix(name, CordonGroupLabelPrefix):
			id, err := strconv.ParseInt(strings.TrimPrefix(name, CordonGroupLabelPrefix), 10, 64)
			if err == nil {
				restoredGroupID = id
			}
		case strings.HasPrefix(name, labelPrefix):
			restoredLabels = append(restoredLabels, strings.TrimPrefix(name, labelPrefix))
		case l.GetType() == "read-only":
			// built-in label, keep untouched (managed automatically by GitHub)
		default:
			restoredLabels = append(restoredLabels, name)
		}
	}
	return restoredLabels, restoredGroupID
}
