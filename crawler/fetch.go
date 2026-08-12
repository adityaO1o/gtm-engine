package main

import (
	"context"
	"crypto/tls"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

// Every guard in this file exists because crawling 250k pages without it eventually kills the run.
//
//   - a size cap, because one agency's "case study" is an 80MB PDF and without a limit that single
//     response is a larger download than a thousand real pages
//   - a content-type filter, so the body is never even read for anything that cannot contain links
//   - a per-host limiter, because 20 parallel requests to one small marketing site gets the proxy
//     banned — and that same proxy pool is what the host.io scrape depends on
//   - a total timeout, because a server that accepts the connection and then stalls forever will
//     otherwise hold a worker slot until the process restarts

const (
	maxBodyBytes   = 2 << 20 // 2 MiB
	fetchTimeout   = 12 * time.Second
	maxRedirects   = 3
	perHostLimit   = 2
	perHostCooldown = 400 * time.Millisecond
)

var errSkipContent = errors.New("not html")

// hostGate serialises requests per host. Politeness is not courtesy here: the proxy pool is shared
// with the rest of the platform, so a burst that gets an exit banned costs the seed funnel too.
type hostGate struct {
	mu    sync.Mutex
	slots map[string]chan struct{}
	last  map[string]time.Time
}

func newHostGate() *hostGate {
	return &hostGate{slots: map[string]chan struct{}{}, last: map[string]time.Time{}}
}

func (g *hostGate) acquire(ctx context.Context, host string) (func(), error) {
	g.mu.Lock()
	ch, ok := g.slots[host]
	if !ok {
		ch = make(chan struct{}, perHostLimit)
		g.slots[host] = ch
	}
	g.mu.Unlock()

	select {
	case ch <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}

	// Space consecutive hits at the same host, on top of the concurrency cap.
	g.mu.Lock()
	if last, ok := g.last[host]; ok {
		if wait := perHostCooldown - time.Since(last); wait > 0 {
			g.mu.Unlock()
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				<-ch
				return nil, ctx.Err()
			}
			g.mu.Lock()
		}
	}
	g.last[host] = time.Now()
	g.mu.Unlock()

	return func() { <-ch }, nil
}

type Fetcher struct {
	clients []*http.Client // one per proxy, plus a direct client
	gate    *hostGate
	rr      uint64
	mu      sync.Mutex
}

func newTransport(proxy *url.URL) *http.Transport {
	t := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 6 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   6 * time.Second,
		ResponseHeaderTimeout: 8 * time.Second,
		MaxIdleConns:          512,
		MaxIdleConnsPerHost:   4,
		IdleConnTimeout:       60 * time.Second,
		// Marketing sites are riddled with expired and mismatched certs. A TLS error here would cost
		// a real prospect for no security benefit: nothing sensitive is sent and only public HTML is
		// read back.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
	if proxy != nil {
		t.Proxy = http.ProxyURL(proxy)
	}
	return t
}

func NewFetcher(proxies []string) *Fetcher {
	f := &Fetcher{gate: newHostGate()}
	mk := func(t *http.Transport) *http.Client {
		return &http.Client{
			Transport: t,
			Timeout:   fetchTimeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= maxRedirects {
					return http.ErrUseLastResponse
				}
				return nil
			},
		}
	}
	for _, p := range proxies {
		u, err := url.Parse(strings.TrimSpace(p))
		if err != nil || u.Host == "" {
			continue
		}
		f.clients = append(f.clients, mk(newTransport(u)))
	}
	// Always keep a direct client: with no proxies configured the crawler must still work.
	f.clients = append(f.clients, mk(newTransport(nil)))
	return f
}

func (f *Fetcher) next() *http.Client {
	f.mu.Lock()
	defer f.mu.Unlock()
	c := f.clients[f.rr%uint64(len(f.clients))]
	f.rr++
	return c
}

// GetRendered re-fetches through r.jina.ai, which runs the page's JavaScript and returns the result
// as text. Client-only React/Vue sites hand a plain fetch an empty shell, and an agency whose whole
// site is a shell is indistinguishable from one with no clients — so this is the difference between
// "we cannot see it" and "there is nothing there".
//
// Only ever called AFTER a normal fetch came back empty, so the cost is bounded by how many sites
// actually need it.
func (f *Fetcher) GetRendered(ctx context.Context, rawURL string) (*Page, error) {
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", "https://r.jina.ai/"+rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/plain")
	if k := os.Getenv("JINA_KEY"); k != "" {
		req.Header.Set("Authorization", "Bearer "+k)
	}

	resp, err := f.next().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return &Page{URL: rawURL, Status: resp.StatusCode}, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil && len(body) == 0 {
		return nil, err
	}
	return &Page{URL: rawURL, FinalURL: rawURL, Status: 200, ContentType: "text/markdown", Body: string(body), Bytes: len(body)}, nil
}

type Page struct {
	URL         string
	FinalURL    string
	Status      int
	ContentType string
	Body        string
	Bytes       int
}

// Get fetches one URL. It returns errSkipContent for anything that is not HTML, without reading the
// body — a distinction worth keeping because "fetched a PDF" is a normal outcome, not a failure.
func (f *Fetcher) Get(ctx context.Context, rawURL string) (*Page, error) {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("bad url")
	}

	release, err := f.gate.acquire(ctx, u.Hostname())
	if err != nil {
		return nil, err
	}
	defer release()

	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	// A plain, current browser UA. Sites that block obvious bots would otherwise serve a challenge
	// page, which parses as "no case studies" and quietly loses the agency.
	req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36")
	req.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	req.Header.Set("Accept-Language", "en-US,en;q=0.9")

	resp, err := f.next().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	ct := resp.Header.Get("Content-Type")
	page := &Page{URL: rawURL, FinalURL: resp.Request.URL.String(), Status: resp.StatusCode, ContentType: ct}

	if resp.StatusCode >= 400 {
		return page, nil // a 404 is an answer, not an error to retry
	}
	if ct != "" && !strings.Contains(ct, "html") && !strings.Contains(ct, "xml") {
		return page, errSkipContent
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil && len(body) == 0 {
		return page, err
	}
	page.Body = string(body)
	page.Bytes = len(body)
	return page, nil
}
