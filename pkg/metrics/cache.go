package metrics

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
)

const (
	cacheDirPerm  os.FileMode = 0o700
	cacheFilePerm os.FileMode = 0o600
)

// Cache stores the job list of completed workflow runs on local disk.
// Entries are scoped per host/owner/repository so that runs from different hosts or
// accounts can never be served to each other.
type Cache struct {
	dir string
}

// NewCache prepares the on-disk cache directory for repo.
func NewCache(repo repository.Repository) (*Cache, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return nil, fmt.Errorf("failed to locate the user cache directory: %w", err)
	}

	dir := filepath.Join(
		base, "gh-runner-kit", "metrics",
		sanitizePathSegment(repo.Host),
		sanitizePathSegment(repo.Owner),
		sanitizePathSegment(repo.Name),
		"jobs",
	)
	if err := os.MkdirAll(dir, cacheDirPerm); err != nil {
		return nil, fmt.Errorf("failed to create the cache directory %s: %w", dir, err)
	}
	return &Cache{dir: dir}, nil
}

// Dir returns the directory the cache writes to.
func (c *Cache) Dir() string {
	return c.dir
}

// LoadJobs returns the cached job list of runID, reporting whether it was present.
func (c *Cache) LoadJobs(runID int64) ([]*github.WorkflowJob, bool) {
	data, err := os.ReadFile(c.jobsPath(runID))
	if err != nil {
		return nil, false
	}

	var jobs []*github.WorkflowJob
	if err := json.Unmarshal(data, &jobs); err != nil {
		return nil, false
	}
	return jobs, true
}

// SaveJobs writes the job list of runID. The write is atomic so that a cancelled run
// never leaves a truncated entry behind.
func (c *Cache) SaveJobs(runID int64, jobs []*github.WorkflowJob) error {
	data, err := json.Marshal(jobs)
	if err != nil {
		return fmt.Errorf("failed to encode the jobs of workflow run %d: %w", runID, err)
	}

	tmp, err := os.CreateTemp(c.dir, ".jobs-*")
	if err != nil {
		return fmt.Errorf("failed to create a cache entry for workflow run %d: %w", runID, err)
	}
	defer os.Remove(tmp.Name())

	if err := tmp.Chmod(cacheFilePerm); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to set the permissions of the cache entry for workflow run %d: %w", runID, err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to write the cache entry for workflow run %d: %w", runID, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close the cache entry for workflow run %d: %w", runID, err)
	}
	if err := os.Rename(tmp.Name(), c.jobsPath(runID)); err != nil {
		return fmt.Errorf("failed to store the cache entry for workflow run %d: %w", runID, err)
	}
	return nil
}

// jobsPath builds the entry path from the numeric run ID, so no caller-supplied string
// ever reaches the file name.
func (c *Cache) jobsPath(runID int64) string {
	return filepath.Join(c.dir, strconv.FormatInt(runID, 10)+".json")
}

// sanitizePathSegment reduces s to a single safe path element.
func sanitizePathSegment(s string) string {
	if s == "" {
		return "_"
	}

	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}

	cleaned := b.String()
	if cleaned == "." || cleaned == ".." || strings.Trim(cleaned, ".") == "" {
		return "_"
	}
	return cleaned
}
