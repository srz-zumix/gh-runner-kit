package metrics

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/cli/go-gh/v2/pkg/repository"
	"github.com/google/go-github/v90/github"
	"github.com/srz-zumix/go-gh-extension/pkg/logger"
)

const (
	runListingTTL      = time.Hour
	runListingFreshAge = 24 * time.Hour
)

type runListingCache struct {
	cache   *Cache
	scope   string
	refresh bool
	now     func() time.Time
}

type cachedRunDay struct {
	Version   int                   `json:"version"`
	Day       time.Time             `json:"day"`
	CreatedAt time.Time             `json:"createdAt"`
	Runs      []*github.WorkflowRun `json:"runs"`
}

type runWindowPart struct {
	window Window
	cached bool
}

// SetRunCache enables hour-lived historical discovery caching. Credentials are
// hashed with the search filters, never written to disk or included in logs.
func (c *Collector) SetRunCache(cache *Cache, refresh bool, token string) {
	if cache == nil {
		c.runCache = nil
		return
	}
	scope, _ := json.Marshal([]string{token, c.opts.Branch, c.opts.Event, c.opts.Workflow})
	c.runCache = &runListingCache{
		cache: cache, scope: fmt.Sprintf("%x", sha256.Sum256(scope)), refresh: refresh, now: time.Now,
	}
}

func (c *runListingCache) path(repo repository.Repository, day time.Time) string {
	return filepath.Join(c.cache.dir(repo, "run-listings"), c.scope, day.Format("2006-01-02")+".json")
}

func validCachedDay(entry cachedRunDay, day, now time.Time) bool {
	return entry.Version == 1 && entry.Day.Equal(day) && !entry.CreatedAt.After(now) && now.Sub(entry.CreatedAt) < runListingTTL
}

// available reads only the canonical header, not the potentially large run list.
// A small run budget must not decode every historical day it will never reach.
func (c *runListingCache) available(repo repository.Repository, day, now time.Time) bool {
	file, err := os.Open(c.path(repo, day))
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn("metrics: failed to inspect the workflow run cache", "error", err)
		}
		return false
	}
	defer func() { _ = file.Close() }()
	decoder := json.NewDecoder(file)
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		logger.Warn("metrics: invalid workflow run cache header")
		return false
	}
	var entry cachedRunDay
	for _, field := range []struct {
		key   string
		value any
	}{{"version", &entry.Version}, {"day", &entry.Day}, {"createdAt", &entry.CreatedAt}} {
		if token, err := decoder.Token(); err != nil || token != field.key {
			logger.Warn("metrics: invalid workflow run cache header")
			return false
		}
		if err := decoder.Decode(field.value); err != nil {
			logger.Warn("metrics: invalid workflow run cache header", "error", err)
			return false
		}
	}
	return validCachedDay(entry, day, now)
}

func (c *runListingCache) load(repo repository.Repository, day, now time.Time) ([]*github.WorkflowRun, bool) {
	file, err := os.Open(c.path(repo, day))
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn("metrics: failed to read the workflow run cache", "error", err)
		}
		return nil, false
	}
	defer func() { _ = file.Close() }()
	var entry cachedRunDay
	decoder := json.NewDecoder(file)
	if err := decoder.Decode(&entry); err != nil {
		logger.Warn("metrics: invalid workflow run cache entry", "error", err)
		return nil, false
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		logger.Warn("metrics: trailing data in workflow run cache entry")
		return nil, false
	}
	if !validCachedDay(entry, day, now) || entry.Runs == nil {
		return nil, false
	}
	window := Window{Start: day, End: day.AddDate(0, 0, 1)}
	for _, run := range entry.Runs {
		if run == nil || run.GetID() <= 0 || !window.Contains(run.GetCreatedAt().Time) {
			logger.Warn("metrics: invalid workflow run cache contents", "day", day)
			return nil, false
		}
	}
	return entry.Runs, true
}

func (c *runListingCache) prune(repo repository.Repository, now time.Time) {
	dir := filepath.Dir(c.path(repo, now.UTC()))
	entries, err := os.ReadDir(dir)
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn("metrics: failed to inspect the workflow run cache", "error", err)
		}
		return
	}
	for _, entry := range entries {
		if !strings.HasSuffix(entry.Name(), ".json") || !entry.Type().IsRegular() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			logger.Warn("metrics: failed to inspect a workflow run cache entry", "error", err)
			continue
		}
		if now.Sub(info.ModTime()) >= runListingTTL {
			if err := os.Remove(filepath.Join(dir, entry.Name())); err != nil && !os.IsNotExist(err) {
				logger.Warn("metrics: failed to remove an expired workflow run cache entry", "error", err)
			}
		}
	}
}

// collect groups adjacent misses into one search, so a cold cache does not turn
// a quiet repository's single request into one request per day.
func (c *runListingCache) collect(ctx context.Context, repo repository.Repository, window Window, limit int,
	list func(Window, int, *runWindowCheckpoint) ([]*github.WorkflowRun, error),
	hit func(Window, []*github.WorkflowRun) error,
) ([]*github.WorkflowRun, error) {
	now := c.now().UTC()
	cutoff := now.Add(-runListingFreshAge)
	c.prune(repo, now)
	var parts []runWindowPart
	for end := window.End; end.After(window.Start); {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		start := end.Add(-time.Nanosecond).UTC().Truncate(24 * time.Hour)
		if start.Before(window.Start) {
			start = window.Start
		}
		part := runWindowPart{window: Window{Start: start, End: end}}
		if !c.refresh && start.Equal(start.UTC().Truncate(24*time.Hour)) &&
			end.Equal(start.Add(24*time.Hour)) && !end.After(cutoff) {
			part.cached = c.available(repo, start, now)
		}
		parts = append(parts, part)
		end = start
	}
	var runs []*github.WorkflowRun
	for index := 0; index < len(parts) && (limit <= 0 || len(runs) < limit); {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		part := parts[index]
		if part.cached {
			if rows, ok := c.load(repo, part.window.Start, c.now().UTC()); ok {
				if err := hit(part.window, rows); err != nil {
					return nil, err
				}
				runs = append(runs, rows...)
				index++
				continue
			}
			parts[index].cached = false
		}
		next := index + 1
		for next < len(parts) {
			if parts[next].cached {
				parts[next].cached = c.available(repo, parts[next].window.Start, c.now().UTC())
			}
			if parts[next].cached {
				break
			}
			part.window.Start = parts[next].window.Start
			next++
		}
		budget := limit
		if limit > 0 {
			budget -= len(runs)
		}
		started := c.now().UTC()
		saved := make(map[int64]bool)
		rows, err := list(part.window, budget, &runWindowCheckpoint{
			now: c.now,
			complete: func(covered Window, rows []*github.WorkflowRun, started time.Time) {
				c.saveDays(repo, covered, cutoff, started, rows, 0, saved)
			},
		})
		if err != nil {
			return nil, err
		}
		slices.SortFunc(rows, compareRunsNewestFirst)
		c.saveDays(repo, part.window, cutoff, started, rows, budget, saved)
		runs = append(runs, rows...)
		index = next
	}
	slices.SortFunc(runs, compareRunsNewestFirst)
	if limit > 0 && len(runs) > limit {
		runs = runs[:limit]
	}
	return runs, nil
}

func compareRunsNewestFirst(a, b *github.WorkflowRun) int {
	if order := b.GetCreatedAt().Compare(a.GetCreatedAt().Time); order != 0 {
		return order
	}
	return cmp.Compare(b.GetID(), a.GetID())
}

func (c *runListingCache) saveDays(repo repository.Repository, window Window, cutoff, started time.Time, rows []*github.WorkflowRun, budget int, saved map[int64]bool) {
	start := window.Start.UTC().Truncate(24 * time.Hour)
	if start.Before(window.Start) {
		start = start.Add(24 * time.Hour)
	}
	// A capped prefix cannot establish a complete cache entry for its oldest day.
	if budget > 0 && len(rows) >= budget {
		oldest := rows[len(rows)-1].GetCreatedAt().Time.UTC().Truncate(24 * time.Hour).Add(24 * time.Hour)
		if oldest.After(start) {
			start = oldest
		}
	}
	pending := make(map[int64]time.Time)
	for day := start; !day.Add(24*time.Hour).After(window.End) && !day.Add(24*time.Hour).After(cutoff); day = day.Add(24 * time.Hour) {
		if !saved[day.Unix()] {
			pending[day.Unix()] = day
		}
	}
	if len(pending) == 0 {
		return
	}
	byDay := make(map[int64][]*github.WorkflowRun, len(pending))
	for _, run := range rows {
		day := run.GetCreatedAt().Time.UTC().Truncate(24 * time.Hour)
		if _, ok := pending[day.Unix()]; ok {
			byDay[day.Unix()] = append(byDay[day.Unix()], run)
		}
	}
	for _, day := range pending {
		dayRows := byDay[day.Unix()]
		if dayRows == nil {
			dayRows = []*github.WorkflowRun{}
		}
		entry := cachedRunDay{Version: 1, Day: day, CreatedAt: started, Runs: dayRows}
		if err := writeCacheEntry(c.path(repo, day), entry); err != nil {
			logger.Warn("metrics: failed to cache workflow runs", "day", day, "error", err)
		} else if saved != nil {
			saved[day.Unix()] = true
		}
	}
}
