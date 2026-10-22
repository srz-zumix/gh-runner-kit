package metrics

import (
	"encoding/json"
	"fmt"
	"io"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

// SnapshotMetadata omits raw run, attempt, job and usage payloads from a snapshot.
type SnapshotMetadata struct {
	Version   int
	CreatedAt time.Time
	Repo      repository.Repository
	Contents  SnapshotContents
	Data      SnapshotDataMetadata
}

// SnapshotDataMetadata is the inventory and coverage needed to interpret row streams.
type SnapshotDataMetadata struct {
	Window           Window
	Runners          []*github.Runner
	HostedRunners    map[string][]*github.HostedRunner
	RepositoryPublic map[string]bool
	Warnings         []string
	Truncated        bool
	Runs             int
	Jobs             int
}

// Metadata projects only the data a dashboard needs alongside runs/jobs NDJSON.
func (s *Snapshot) Metadata() SnapshotMetadata {
	data := s.Data
	return SnapshotMetadata{
		Version: s.Version, CreatedAt: s.CreatedAt, Repo: s.Repo, Contents: s.Contents,
		Data: SnapshotDataMetadata{
			Window: data.Window, Runners: data.Runners,
			HostedRunners: data.HostedRunners, RepositoryPublic: data.RepositoryPublic,
			Warnings: data.Warnings, Truncated: data.Truncated,
			Runs: len(data.Runs), Jobs: len(data.Jobs),
		},
	}
}

// Filter retains all attempts and jobs of runs created in the closed-open window.
// Inventory and coverage warnings remain those of the original collection.
func (s *Snapshot) Filter(window Window) (*Snapshot, error) {
	if !window.Start.Before(window.End) {
		return nil, fmt.Errorf("the filtered snapshot start must be before its end")
	}
	if window.Start.Before(s.Data.Window.Start) || window.End.After(s.Data.Window.End) {
		return nil, fmt.Errorf("the filtered snapshot window must be within the collected period")
	}
	snapshot := *s
	data := *s.Data
	snapshot.Data = &data
	data.Window = window
	data.Runs = nil
	data.Attempts = nil
	data.Jobs = nil
	data.LatestJobs = make(map[int64]bool)
	data.RunRepositories = make(map[int64]string)
	data.Usage = make(map[int64]*github.WorkflowRunUsage)
	selected := make(map[int64]bool)
	counts := make(map[string]int)
	for _, run := range s.Data.Runs {
		if !run.GetCreatedAt().IsZero() && window.Contains(run.GetCreatedAt().Time) {
			data.Runs = append(data.Runs, run)
			selected[run.GetID()] = true
		}
	}
	for _, run := range s.Data.Attempts {
		if selected[run.GetID()] {
			data.Attempts = append(data.Attempts, run)
		}
	}
	for _, job := range s.Data.Jobs {
		if selected[job.GetRunID()] {
			data.Jobs = append(data.Jobs, job)
			if latest, ok := s.Data.LatestJobs[job.GetID()]; ok {
				data.LatestJobs[job.GetID()] = latest
			}
		}
	}
	for id, repo := range s.Data.RunRepositories {
		if selected[id] {
			data.RunRepositories[id] = repo
			counts[repo]++
		}
	}
	for id, usage := range s.Data.Usage {
		if selected[id] {
			data.Usage[id] = usage
		}
	}
	data.Repos = make([]RepoCoverage, len(s.Data.Repos))
	for i, coverage := range s.Data.Repos {
		coverage.Runs = counts[coverage.FullName()]
		data.Repos[i] = coverage
	}
	return &snapshot, nil
}

// PrepareSnapshot reads and optionally filters/writes a snapshot without API requests.
func PrepareSnapshot(input, output, since, until string) (SnapshotMetadata, error) {
	if input == "" {
		return SnapshotMetadata{}, fmt.Errorf("--input is required")
	}
	if output == "-" {
		return SnapshotMetadata{}, fmt.Errorf("--output must name a file because stdout carries snapshot metadata")
	}
	snapshot, err := ReadSnapshot(input)
	if err != nil {
		return SnapshotMetadata{}, err
	}
	if since != "" || until != "" {
		window := snapshot.Data.Window
		if since != "" {
			window.Start, err = parseBoundary("since", since)
			if err != nil {
				return SnapshotMetadata{}, err
			}
		}
		if until != "" {
			window.End, err = parseBoundary("until", until)
			if err != nil {
				return SnapshotMetadata{}, err
			}
		}
		snapshot, err = snapshot.Filter(window)
		if err != nil {
			return SnapshotMetadata{}, err
		}
	}
	if output != "" {
		if err := WriteSnapshot(output, snapshot); err != nil {
			return SnapshotMetadata{}, err
		}
	}
	return snapshot.Metadata(), nil
}

// WriteSnapshotMetadata writes the compact projection, not the full raw snapshot.
func WriteSnapshotMetadata(w io.Writer, metadata SnapshotMetadata) error {
	return json.NewEncoder(w).Encode(metadata)
}
