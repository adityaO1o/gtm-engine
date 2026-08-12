package main

import (
	"context"
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// Turning a company NAME into a domain.
//
// Most agencies do not link the companies they name — a logo grid, a testimonial with a name under
// it, a heading that says "How we helped Acme". Dropping all of those loses most of the clients on
// the page, so this resolves them: search the name, then PROVE the answer before using it.
//
// The proof step is the whole design. A wrong domain does not merely waste a scan — it puts another
// company's blacklisted infrastructure in front of a prospect as if it were their client's, which is
// the single most expensive mistake this pipeline can make. So a candidate is accepted only when the
// site itself says the name back: no verification, no client.

var stripCorp = regexp.MustCompile(`(?i)\b(inc|llc|ltd|limited|corp|corporation|company|co|gmbh|bv|pty|plc|sa|ag|group|holdings|technologies|technology|solutions|software|labs|media|digital|agency|studio|consulting|partners)\b\.?`)
var nonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

// normaliseName reduces a company name to comparable letters: "Acme Solutions, Inc." -> "acme".
func normaliseName(s string) string {
	s = strings.ToLower(s)
	s = stripCorp.ReplaceAllString(s, " ")
	return nonAlnum.ReplaceAllString(s, "")
}

// Search engines that answer over a plain proxied GET. DDG Lite first: it is the cheapest to parse
// and the least aggressive about blocking.
var searchEngines = []struct {
	name string
	url  func(string) string
}{
	{"ddg", func(q string) string { return "https://lite.duckduckgo.com/lite/?q=" + url.QueryEscape(q) }},
	{"bing", func(q string) string { return "https://www.bing.com/search?q=" + url.QueryEscape(q) }},
	{"brave", func(q string) string { return "https://search.brave.com/search?q=" + url.QueryEscape(q) }},
}

// Result links out of a SERP, in order. DDG Lite wraps them in a redirect; the others are plain.
var ddgRedirectRe = regexp.MustCompile(`uddg=([^&"]+)`)
var hrefRe = regexp.MustCompile(`href="(https?://[^"]+)"`)

func serpDomains(body string, limit int) []string {
	seen := map[string]bool{}
	var out []string
	add := func(raw string) {
		if len(out) >= limit {
			return
		}
		u, err := url.Parse(raw)
		if err != nil {
			return
		}
		h := registrableHost(u.Hostname())
		if h == "" || notAClient[h] || seen[h] {
			return
		}
		// Search engines' own hosts, and the aggregators that dominate company-name queries.
		switch h {
		case "duckduckgo.com", "bing.com", "brave.com", "google.com", "msn.com", "yahoo.com":
			return
		}
		seen[h] = true
		out = append(out, h)
	}

	for _, m := range ddgRedirectRe.FindAllStringSubmatch(body, -1) {
		if dec, err := url.QueryUnescape(m[1]); err == nil {
			add(dec)
		}
	}
	for _, m := range hrefRe.FindAllStringSubmatch(body, -1) {
		add(m[1])
	}
	return out
}

// verify fetches the candidate and checks the site says the name back — in its <title>, its <h1>, or
// its own domain label. Anything less and we would be guessing.
func (c *Crawler) verify(ctx context.Context, domain, name string) bool {
	want := normaliseName(name)
	if len(want) < 3 {
		return false // too short to be evidence of anything
	}

	// The domain itself is the strongest signal: "acme.com" for "Acme".
	if strings.Contains(normaliseName(strings.Split(domain, ".")[0]), want) ||
		strings.Contains(want, normaliseName(strings.Split(domain, ".")[0])) {
		return true
	}

	p, err := c.getCached(ctx, "https://"+domain)
	if err != nil || p == nil || p.Status >= 400 || p.Body == "" {
		return false
	}
	haystack := normaliseName(titleOf(p.Body) + " " + headingOf(p.Body))
	return strings.Contains(haystack, want)
}

// ResolveCompanyDomain searches for a company name and returns a VERIFIED domain, or "".
func (c *Crawler) ResolveCompanyDomain(ctx context.Context, name string) (string, string) {
	q := strings.TrimSpace(name)
	if len(q) < 3 {
		return "", ""
	}

	for _, eng := range searchEngines {
		p, err := c.getCached(ctx, eng.url(q+" official site"))
		if err != nil || p == nil || p.Body == "" {
			continue
		}
		for _, d := range serpDomains(p.Body, 5) {
			if c.verify(ctx, d, name) {
				return d, eng.name
			}
		}
	}
	return "", ""
}

// Company names on a page that are NOT links: logo alt text and testimonial attributions. This is
// where the clients an agency never linked actually live.
func ExtractClientNames(base *url.URL, body string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(s string) {
		s = strings.TrimSpace(s)
		// Logo alt text is usually "Acme logo" or "Acme - client"; strip the furniture words.
		s = regexp.MustCompile(`(?i)\s*[-–|]?\s*(logo|icon|client|customer|partner|brand)s?\s*$`).ReplaceAllString(s, "")
		s = strings.TrimSpace(s)
		if len(s) < 3 || len(s) > 50 {
			return
		}
		k := normaliseName(s)
		if k == "" || seen[k] || len(out) >= 40 {
			return
		}
		seen[k] = true
		out = append(out, s)
	}

	doc, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return nil
	}
	root := doc
	if m := mainContent(doc); m != nil {
		root = m
	}

	var walk func(n *html.Node)
	walk = func(n *html.Node) {
		if n != root && isChrome(n) {
			return
		}
		if n.Type == html.ElementNode && n.Data == "img" {
			for _, a := range n.Attr {
				if a.Key == "alt" {
					add(a.Val)
				}
			}
		}
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(root)
	return out
}
