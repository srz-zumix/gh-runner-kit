package metrics

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
)

// CurrentSnapshotVersion is written to every snapshot and checked on read, so a
// future incompatible format never gets silently misread as this one.
const CurrentSnapshotVersion = 1

// snapshotFilePerm matches the permissions the per-run cache already uses for the data
// it writes to disk.
const snapshotFilePerm = 0o600

// SnapshotContents records which optional parts of Data a collection actually
// populated, because a nil Jobs or Usage is otherwise indistinguishable from "never
// collected" and "collected, found none".
type SnapshotContents struct {
	Jobs    bool
	Usage   bool
	Runners bool
}

// Snapshot is what `metrics collect` writes and every other metrics command can read
// back with --input instead of issuing its own API requests.
type Snapshot struct {
	Version   int
	CreatedAt time.Time
	// Repo is the scope metrics collect was given: an owner/repo, or an owner alone
	// when --all-repos or --owner was used without --repo.
	Repo     repository.Repository
	Contents SnapshotContents
	Data     *Data
}

// Require reports an error naming what is missing when the snapshot lacks data a
// report needs, rather than letting the report silently compute from zero values.
func (s *Snapshot) Require(jobs, usage bool) error {
	if jobs && !s.Contents.Jobs {
		return fmt.Errorf("the snapshot was collected without workflow jobs, which this report needs")
	}
	if usage && !s.Contents.Usage {
		return fmt.Errorf("the snapshot was collected without billable usage; recollect with `metrics collect --usage`")
	}
	return nil
}

// WriteSnapshot encodes snap as JSON to path, gzip-compressing it when path ends in
// .gz. path may be "-" for stdout. The write goes to a temporary file and is renamed
// into place, so an interrupted write never leaves a truncated snapshot behind.
func WriteSnapshot(path string, snap *Snapshot) error {
	if path == "-" {
		return encodeSnapshot(os.Stdout, snap, false)
	}

	tmp, err := os.CreateTemp(filepath.Dir(path), ".snapshot-*")
	if err != nil {
		return fmt.Errorf("failed to create a temporary file for the snapshot: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()

	if err := tmp.Chmod(snapshotFilePerm); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("failed to set the permissions of the snapshot: %w", err)
	}
	if err := encodeSnapshot(tmp, snap, strings.HasSuffix(path, ".gz")); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close the snapshot file: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("failed to write the snapshot to %s: %w", path, err)
	}
	return nil
}

func encodeSnapshot(w io.Writer, snap *Snapshot, gzipped bool) error {
	if gzipped {
		gz := gzip.NewWriter(w)
		if err := json.NewEncoder(gz).Encode(snap); err != nil {
			_ = gz.Close()
			return fmt.Errorf("failed to encode the snapshot: %w", err)
		}
		if err := gz.Close(); err != nil {
			return fmt.Errorf("failed to finish the gzip stream: %w", err)
		}
		return nil
	}
	if err := json.NewEncoder(w).Encode(snap); err != nil {
		return fmt.Errorf("failed to encode the snapshot: %w", err)
	}
	return nil
}

// ReadSnapshot decodes the snapshot at path, transparently gunzipping it when path
// ends in .gz. path may be "-" for stdin.
func ReadSnapshot(path string) (*Snapshot, error) {
	var r io.Reader
	if path == "-" {
		r = os.Stdin
	} else {
		f, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("failed to open the snapshot %s: %w", path, err)
		}
		defer func() { _ = f.Close() }()
		r = f

		if strings.HasSuffix(path, ".gz") {
			gz, err := gzip.NewReader(f)
			if err != nil {
				return nil, fmt.Errorf("failed to open the gzip stream of %s: %w", path, err)
			}
			defer func() { _ = gz.Close() }()
			r = gz
		}
	}

	var snap Snapshot
	if err := json.NewDecoder(r).Decode(&snap); err != nil {
		return nil, fmt.Errorf("failed to decode the snapshot %s: %w", path, err)
	}
	if snap.Version != CurrentSnapshotVersion {
		return nil, fmt.Errorf("the snapshot %s has version %d, which this build does not understand (expected %d)", path, snap.Version, CurrentSnapshotVersion)
	}
	if snap.Data == nil {
		return nil, fmt.Errorf("the snapshot %s carries no data and cannot be used as an --input", path)
	}
	return &snap, nil
}
