package main

import (
	"net/url"
	"regexp"
	"strings"

	"golang.org/x/net/html"
)

// Finding an agency's clients is the part with no standard to lean on. The order below is
// cheapest-and-most-reliable first, and each step is allowed to fail — an agency with no discoverable
// case studies is a normal outcome, not an error, and treating it as one is what keeps the queue from
// retrying thousands of sites that will never yield anything.

var caseStudyPathRe = regexp.MustCompile(`(?i)/(case[-_]?stud|success[-_]?stor|customer[-_]?stor|client[-_]?stor|our[-_]?work|/work/|portfolio|clients?|projects?|results)`)

// Paths that look like case-study INDEXES rather than individual studies.
var indexPathRe = regexp.MustCompile(`(?i)/(case[-_]?studies|success[-_]?stories|customer[-_]?stories|our[-_]?work|work|portfolio|clients|projects)/?$`)

// Anchor text that names a case-study section in a nav.
var navTextRe = regexp.MustCompile(`(?i)^\s*(case stud(y|ies)|success stor(y|ies)|customer stor(y|ies)|our work|work|portfolio|clients|our clients|projects|results)\s*$`)

// Hosts that are never a client: social, analytics, CDNs, the usual furniture of a marketing site.
var notAClient = map[string]bool{
	"facebook.com": true, "twitter.com": true, "x.com": true, "linkedin.com": true, "instagram.com": true,
	"youtube.com": true, "youtu.be": true, "tiktok.com": true, "pinterest.com": true, "medium.com": true,
	"github.com": true, "google.com": true, "goo.gl": true, "gstatic.com": true, "googleapis.com": true,
	"cloudflare.com": true, "wordpress.com": true, "wp.com": true, "squarespace.com": true, "wix.com": true,
	"webflow.io": true, "hubspot.com": true, "calendly.com": true, "vimeo.com": true, "gravatar.com": true,
	"cdn.jsdelivr.net": true, "unpkg.com": true, "apple.com": true, "microsoft.com": true, "amazon.com": true,
	"typeform.com": true, "notion.so": true, "substack.com": true, "mailchimp.com": true, "canva.com": true,
	"adobe.com": true, "figma.com": true, "slack.com": true, "zoom.us": true, "stripe.com": true,
}

type Link struct {
	URL  string
	Text string
}

func parseLinks(base *url.URL, body string) []Link {
	doc, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return nil
	}
	var out []Link
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.ElementNode && n.Data == "a" {
			var href string
			for _, a := range n.Attr {
				if a.Key == "href" {
					href = a.Val
				}
			}
			if href != "" && !strings.HasPrefix(href, "#") && !strings.HasPrefix(href, "mailto:") && !strings.HasPrefix(href, "tel:") && !strings.HasPrefix(href, "javascript:") {
				if u, err := base.Parse(href); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
					u.Fragment = ""
					out = append(out, Link{URL: u.String(), Text: strings.TrimSpace(textOf(n))})
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return out
}

func textOf(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n.Type == html.TextNode {
			b.WriteString(n.Data)
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(n)
	return strings.Join(strings.Fields(b.String()), " ")
}

func titleOf(body string) string {
	doc, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return ""
	}
	var title string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if title != "" {
			return
		}
		if n.Type == html.ElementNode && n.Data == "title" {
			title = textOf(n)
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return title
}

// FindCaseStudyIndexes returns the pages on an agency's own site most likely to LIST its clients.
// Sitemap first: it is one request, needs no parsing heuristics, and when present it is exhaustive.
func FindCaseStudyIndexes(base *url.URL, homeBody string, sitemapURLs []string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(u string) {
		if !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}

	for _, u := range sitemapURLs {
		if indexPathRe.MatchString(u) {
			add(u)
		}
	}
	for _, l := range parseLinks(base, homeBody) {
		lu, err := url.Parse(l.URL)
		if err != nil || !sameSite(base.Hostname(), lu.Hostname()) {
			continue
		}
		if indexPathRe.MatchString(lu.Path) || navTextRe.MatchString(l.Text) {
			add(l.URL)
		}
	}
	if len(out) > 4 {
		out = out[:4]
	}
	return out
}

// FindCaseStudyPages returns the individual case-study URLs linked from an index page (plus any the
// sitemap already revealed).
func FindCaseStudyPages(base *url.URL, indexBody string, sitemapURLs []string, limit int) []string {
	seen := map[string]bool{}
	var out []string
	add := func(u string) {
		if seen[u] || len(out) >= limit {
			return
		}
		seen[u] = true
		out = append(out, u)
	}

	for _, l := range parseLinks(base, indexBody) {
		lu, err := url.Parse(l.URL)
		if err != nil || !sameSite(base.Hostname(), lu.Hostname()) {
			continue
		}
		// An individual study lives UNDER the section, so it has more path than the index itself.
		if caseStudyPathRe.MatchString(lu.Path) && !indexPathRe.MatchString(lu.Path) && strings.Count(strings.Trim(lu.Path, "/"), "/") >= 1 {
			add(lu.String())
		}
	}
	for _, u := range sitemapURLs {
		if pu, err := url.Parse(u); err == nil && caseStudyPathRe.MatchString(pu.Path) && !indexPathRe.MatchString(pu.Path) {
			add(u)
		}
	}
	return out
}

type ClientHit struct {
	Domain     string
	Name       string
	Confidence string // "outbound-link" | "title"
}

// ExtractClient pulls the client identity out of one case-study page.
//
// The OUTBOUND LINK is the signal worth having: a case study almost always links to the company it
// is about, and that link is the client's actual domain — which skips name-to-domain resolution
// entirely, along with everything that can go wrong in it. The page title is a fallback that yields
// only a name, and a name still has to be resolved before it is worth anything.
func ExtractClient(base *url.URL, pageURL, body string) *ClientHit {
	u, err := url.Parse(pageURL)
	if err != nil {
		return nil
	}
	agencyHost := registrableHost(base.Hostname())

	counts := map[string]int{}
	names := map[string]string{}
	for _, l := range parseLinks(u, body) {
		lu, err := url.Parse(l.URL)
		if err != nil {
			continue
		}
		h := registrableHost(lu.Hostname())
		if h == "" || h == agencyHost || notAClient[h] {
			continue
		}
		// Skip obvious infrastructure subdomains of the agency itself and common trackers.
		if strings.HasSuffix(h, ".gov") || strings.HasSuffix(h, ".edu") {
			continue
		}
		counts[h]++
		if names[h] == "" && l.Text != "" && len(l.Text) < 60 {
			names[h] = l.Text
		}
	}

	best, bestN := "", 0
	for h, n := range counts {
		if n > bestN {
			best, bestN = h, n
		}
	}
	if best != "" {
		return &ClientHit{Domain: best, Name: names[best], Confidence: "outbound-link"}
	}

	// Nothing linked out. Fall back to the title, which often reads "How we helped Acme grow" — a
	// name only, so downstream still has to resolve it to a domain.
	if t := titleOf(body); t != "" {
		if name := clientNameFromTitle(t); name != "" {
			return &ClientHit{Name: name, Confidence: "title"}
		}
	}
	return nil
}

var titlePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^(?:case study|client story|success story)\s*[:|–—-]\s*(.+?)\s*(?:[|–—-].*)?$`),
	regexp.MustCompile(`(?i)^how (?:we )?(?:helped|we help)\s+(.+?)\s+(?:to\s+)?[a-z]`),
	regexp.MustCompile(`(?i)^(.+?)\s+(?:case study|success story|client story)`),
}

func clientNameFromTitle(t string) string {
	for _, re := range titlePatterns {
		if m := re.FindStringSubmatch(t); len(m) > 1 {
			n := strings.TrimSpace(m[1])
			if len(n) > 1 && len(n) < 60 {
				return n
			}
		}
	}
	return ""
}

func sameSite(a, b string) bool { return registrableHost(a) == registrableHost(b) }

var twoPartTLDs = map[string]bool{
	"co.uk": true, "org.uk": true, "ac.uk": true, "gov.uk": true, "co.in": true, "net.in": true,
	"org.in": true, "com.au": true, "net.au": true, "org.au": true, "co.nz": true, "com.br": true,
	"com.sg": true, "com.my": true, "co.za": true, "co.jp": true, "com.mx": true, "com.tr": true,
}

func registrableHost(h string) string {
	h = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(h), "www."))
	if h == "" {
		return ""
	}
	parts := strings.Split(h, ".")
	if len(parts) < 2 {
		return ""
	}
	if len(parts) >= 3 {
		if lastTwo := strings.Join(parts[len(parts)-2:], "."); twoPartTLDs[lastTwo] {
			return strings.Join(parts[len(parts)-3:], ".")
		}
	}
	return strings.Join(parts[len(parts)-2:], ".")
}

// ParseSitemap pulls <loc> values out of a sitemap or sitemap index. Deliberately regex-based rather
// than a full XML parse: sitemaps in the wild are frequently malformed, and a strict parser rejects
// the whole document over one bad entity.
var locRe = regexp.MustCompile(`(?is)<loc>\s*([^<\s]+)\s*</loc>`)

func ParseSitemap(body string) []string {
	var out []string
	for _, m := range locRe.FindAllStringSubmatch(body, -1) {
		if len(m) > 1 {
			out = append(out, strings.TrimSpace(m[1]))
		}
	}
	return out
}
