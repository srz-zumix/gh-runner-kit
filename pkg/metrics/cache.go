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

// Cache stores per run data of completed workflow runs on local disk.
// Entries are scoped per host/owner/repository and per kind, so that runs from different
// hosts, accounts or repositories are kept apart for normal GitHub identifiers.
type Cache struct {
	base string
}

// The kinds of per run data the cache keeps apart. They double as directory names.
const (
	jobsKind  = "jobs"
	usageKind = "usage"
)

// NewCache prepares the on-disk cache root. Individual entries are placed under a
// per-repository subdirectory derived from the repository passed to LoadJobs and
// SaveJobs, so a single cache can serve a collection that spans repositories.
// Creating the root here lets callers detect an unusable cache location up front.
func NewCache() (*Cache, error) {
	dir, err := os.UserCacheDir()
	if err != nil {
		return nil, fmt.Errorf("failed to locate the user cache directory: %w", err)
	}
	base := filepath.Join(dir, "gh-runner-kit", "metrics")
	if err := os.MkdirAll(base, cacheDirPerm); err != nil {
		return nil, fmt.Errorf("failed to create the cache directory %s: %w", base, err)
	}
	return &Cache{base: base}, nil
}

// LoadJobs returns the cached job list of repo's runID, reporting whether it was present.
func (c *Cache) LoadJobs(repo repository.Repository, runID int64) ([]*github.WorkflowJob, bool) {
	return load[[]*github.WorkflowJob](c, repo, jobsKind, runID)
}

// SaveJobs writes the job list of repo's runID.
func (c *Cache) SaveJobs(repo repository.Repository, runID int64, jobs []*github.WorkflowJob) error {
	return c.save(repo, jobsKind, runID, jobs)
}

// LoadUsage returns the cached billable usage of repo's runID, reporting whether it was
// present.
func (c *Cache) LoadUsage(repo repository.Repository, runID int64) (*github.WorkflowRunUsage, bool) {
	usage, ok := load[*github.WorkflowRunUsage](c, repo, usageKind, runID)
	if !ok || usage == nil {
		return nil, false
	}
	return usage, true
}

// SaveUsage writes the billable usage of repo's runID.
func (c *Cache) SaveUsage(repo repository.Repository, runID int64, usage *github.WorkflowRunUsage) error {
	return c.save(repo, usageKind, runID, usage)
}

// dir returns the per-repository directory that holds the cached entries of one kind.
func (c *Cache) dir(repo repository.Repository, kind string) string {
	return filepath.Join(
		c.base,
		sanitizePathSegment(repo.Host),
		sanitizePathSegment(repo.Owner),
		sanitizePathSegment(repo.Name),
		kind,
	)
}

// path builds the entry path from the numeric run ID, so no caller-supplied string ever
// reaches the file name.
func (c *Cache) path(repo repository.Repository, kind string, runID int64) string {
	return filepath.Join(c.dir(repo, kind), strconv.FormatInt(runID, 10)+".json")
}

// load decodes the entry of repo's runID, reporting whether a usable one was present.
// A missing, unreadable or partially written entry is reported as a miss.
func load[T any](c *Cache, repo repository.Repository, kind string, runID int64) (T, bool) {
	var value T

	data, err := os.ReadFile(c.path(repo, kind, runID))
	if err != nil {
		return value, false
	}
	if err := json.Unmarshal(data, &value); err != nil {
		var zero T
		return zero, false
	}
	return value, true
}

// save writes the entry of repo's runID. It writes to a temporary file and renames it into
// place, which is atomic on Unix, so an interrupted write never leaves a truncated entry
// behind. A partial entry would in any case be treated as a cache miss on load.
func (c *Cache) save(repo repository.Repository, kind string, runID int64, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("failed to encode the %s of workflow run %d: %w", kind, runID, err)
	}

	dir := c.dir(repo, kind)
	if err := os.MkdirAll(dir, cacheDirPerm); err != nil {
		return fmt.Errorf("failed to create the cache directory %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, "."+kind+"-*")
	if err != nil {
		return fmt.Errorf("failed to create a cache entry for workflow run %d: %w", runID, err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()

	if err := tmp.Chmod(cacheFilePerm); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("failed to set the permissions of the cache entry for workflow run %d: %w", runID, err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("failed to write the cache entry for workflow run %d: %w", runID, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to close the cache entry for workflow run %d: %w", runID, err)
	}
	if err := os.Rename(tmp.Name(), c.path(repo, kind, runID)); err != nil {
		return fmt.Errorf("failed to store the cache entry for workflow run %d: %w", runID, err)
	}
	return nil
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
