package metrics

import (
	"fmt"
	"sync"
	"time"
)

// CollectionProgress describes one stage, not a percentage of the whole collection.
type CollectionProgress struct {
	Stage             string `json:"stage"`
	Repository        string `json:"repository,omitempty"`
	RepositoryIndex   int    `json:"repositoryIndex"`
	RepositoriesTotal int    `json:"repositoriesTotal"`
	Unit              string `json:"unit,omitempty"`
	Completed         int    `json:"completed"`
	Total             int    `json:"total"`
	Cached            int    `json:"cached"`
	Fetched           int    `json:"fetched"`
	Skipped           int    `json:"skipped"`
	Runs              int    `json:"runs"`
	Jobs              int    `json:"jobs"`
}

type collectionProgress struct {
	mu       sync.Mutex
	value    CollectionProgress
	callback func(CollectionProgress) error
	last     time.Time
	err      error
}

func (p *collectionProgress) emit() error {
	if p.err == nil && p.callback != nil {
		if err := p.callback(p.value); err != nil {
			p.err = fmt.Errorf("failed to report collection progress: %w", err)
		}
		p.last = time.Now()
	}
	return p.err
}

func (p *collectionProgress) stage(stage, repo, unit string, total int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.value.Stage, p.value.Repository, p.value.Unit = stage, repo, unit
	p.value.Completed, p.value.Total = 0, total
	p.value.Cached, p.value.Fetched, p.value.Skipped = 0, 0, 0
	return p.emit()
}

func (p *collectionProgress) advance(cached, skipped bool) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.value.Completed++
	switch {
	case skipped:
		p.value.Skipped++
	case cached:
		p.value.Cached++
	default:
		p.value.Fetched++
	}
	if p.callback == nil {
		return p.err
	}
	if p.value.Completed == p.value.Total || time.Since(p.last) >= 200*time.Millisecond {
		return p.emit()
	}
	return p.err
}

func (p *collectionProgress) flush() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.emit()
}

func (p *collectionProgress) repository(index, total int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.value.RepositoryIndex, p.value.RepositoriesTotal = index, total
}

func (p *collectionProgress) collected(runs, jobs int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.value.Runs, p.value.Jobs = runs, jobs
}
