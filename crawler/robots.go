package main

import (
	"context"
	"strings"
	"sync"
)

// robots.txt, respected per host.
//
// Not a legal exercise: ignoring it is how a crawler gets its proxy exits banned, and those exits are
// shared with the seed funnel's host.io scrape. A site that asks not to be crawled and is crawled
// anyway costs us the pool, not just the page.
//
// Fetched once per host and cached for the process's life — a run touches a host a handful of times,
// so re-reading it would cost more than it saves.

type robots struct {
	mu    sync.RWMutex
	rules map[string][]string // host -> disallowed path prefixes ("" means fetched, nothing blocked)
}

func newRobots() *robots { return &robots{rules: map[string][]string{}} }

// parse reads the groups that apply to us: User-agent: * only. A crawler that reads its own name out
// of a more specific group and then ignores the wildcard is worse than one that reads neither.
func parseRobots(body string) []string {
	var out []string
	applies := false
	for _, raw := range strings.Split(body, "\n") {
		line := strings.TrimSpace(raw)
		if i := strings.Index(line, "#"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		k = strings.ToLower(strings.TrimSpace(k))
		v = strings.TrimSpace(v)

		switch k {
		case "user-agent":
			applies = v == "*"
		case "disallow":
			if applies && v != "" {
				out = append(out, v)
			}
		}
	}
	return out
}

func (r *robots) allowed(ctx context.Context, f *Fetcher, scheme, host, path string) bool {
	r.mu.RLock()
	rules, known := r.rules[host]
	r.mu.RUnlock()

	if !known {
		rules = nil
		if p, err := f.Get(ctx, scheme+"://"+host+"/robots.txt"); err == nil && p.Status == 200 && p.Body != "" {
			rules = parseRobots(p.Body)
		}
		r.mu.Lock()
		r.rules[host] = rules
		r.mu.Unlock()
	}

	if path == "" {
		path = "/"
	}
	for _, d := range rules {
		// "/" disallows the whole site. Anything else is a prefix match, which is what the standard
		// specifies and what every real robots.txt relies on.
		if d == "/" || strings.HasPrefix(path, d) {
			return false
		}
	}
	return true
}
