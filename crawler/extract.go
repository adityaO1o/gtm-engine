package main

import (
	"net/url"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/net/html"
)

// Finding an agency's clients is the part with no standard to lean on. The order below is
// cheapest-and-most-reliable first, and each step is allowed to fail — an agency with no discoverable
// case studies is a normal outcome, not an error, and treating it as one is what keeps the queue from
// retrying thousands of sites that will never yield anything.

var caseStudyPathRe = regexp.MustCompile(`(?i)/(case[-_]?stud|success[-_]?stor|customer[-_]?stor|customer[-_]?love|client[-_]?stor|customers?|testimonial|client[-_]?result|our[-_]?work|/work/|portfolio|clients?|projects?|results|wins|outcomes|proof|stories)`)

// Paths that look like case-study INDEXES rather than individual studies.
var indexPathRe = regexp.MustCompile(`(?i)/(case[-_]?studies|success[-_]?stories|customer[-_]?stories|customers?[-_]?love|customers?|testimonials?|client[-_]?results?|case[-_]?results?|our[-_]?work|work|portfolio|clients|our[-_]?clients|projects|results|wins|outcomes|proof|stories)/?$`)

// Anchor text that names a case-study section in a nav.
var navTextRe = regexp.MustCompile(`(?i)^\s*(case stud(y|ies)|success stor(y|ies)|customer stor(y|ies)|customers?|customers? love|testimonials?|client results|our work|work|portfolio|clients|our clients|projects|results|wins|outcomes|proof|stories)\s*$`)

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
	// Review sites and directories: an agency links its own badge, not a client.
	"g2.com": true, "g2crowd.com": true, "capterra.com": true, "clutch.co": true, "trustpilot.com": true,
	"trustradius.com": true, "goodfirms.co": true, "designrush.com": true, "themanifest.com": true,
	"sourceforge.net": true, "producthunt.com": true, "glassdoor.com": true, "indeed.com": true,
	// Press, research and reference: cited, never a client.
	"hbr.org": true, "forbes.com": true, "entrepreneur.com": true, "inc.com": true, "techcrunch.com": true,
	"businessinsider.com": true, "statista.com": true, "gartner.com": true, "wikipedia.org": true,
	"crunchbase.com": true, "nytimes.com": true, "wsj.com": true, "bbc.co.uk": true, "theguardian.com": true,
}

// Dedupe key for a page URL. www vs non-www and a trailing slash are the SAME page, but they are
// different strings — and the index page yields relative links resolved against the bare host while
// the sitemap lists the www form. Deduping on the raw string fetched every case study twice: six
// pages reported as twelve.
func canonicalURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.Host = strings.TrimPrefix(strings.ToLower(u.Host), "www.")
	u.Scheme = "https"
	u.Fragment = ""
	if u.Path != "/" {
		u.Path = strings.TrimSuffix(u.Path, "/")
	}
	return u.String()
}

type Link struct {
	URL  string
	Text string
}

// Site chrome. These carry the SAME links on every page of a site — the social icons, the review
// badge, the partner logos — so counting them is what let a footer G2 badge outrank the one link in
// the body that actually names the client. Skipping the whole subtree is the fix for both the wrong
// answers and the missing ones.
var chromeTags = map[string]bool{"header": true, "footer": true, "nav": true, "aside": true, "script": true, "style": true}

func isChrome(n *html.Node) bool {
	if n.Type != html.ElementNode {
		return false
	}
	if chromeTags[n.Data] {
		return true
	}
	// Match class/id TOKENS, not substrings. "banner" as a substring hits a hero section and "nav"
	// hits anything named "navy" — on a Webflow or Framer site that silently deletes the page body,
	// which is how a working extractor started returning nothing at all.
	for _, a := range n.Attr {
		if a.Key != "class" && a.Key != "id" && a.Key != "role" {
			continue
		}
		for _, tok := range strings.FieldsFunc(strings.ToLower(a.Val), func(r rune) bool {
			return r == ' ' || r == '-' || r == '_'
		}) {
			if chromeTokens[tok] {
				return true
			}
		}
	}
	return false
}

var chromeTokens = map[string]bool{
	"footer": true, "header": true, "nav": true, "navbar": true, "navigation": true,
	"sidebar": true, "cookie": true, "cookies": true, "menu": true, "topbar": true,
}

func parseLinksIn(base *url.URL, root *html.Node) []Link {
	var out []Link
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if n != root && isChrome(n) {
			return
		}
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
	walk(root)
	return out
}

// The page's main content if it declares one. A case study that wraps its body in <main> or
// <article> hands us the answer directly; everything else falls back to the whole document minus
// chrome.
func mainContent(doc *html.Node) *html.Node {
	var found *html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if found != nil {
			return
		}
		if n.Type == html.ElementNode && (n.Data == "main" || n.Data == "article") {
			found = n
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return found
}

// Links from the page's CONTENT — chrome excluded. For deciding which company a case study is about.
func parseContentLinks(base *url.URL, body string) []Link {
	doc, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return nil
	}
	if m := mainContent(doc); m != nil {
		if links := parseLinksIn(base, m); len(links) > 0 {
			return links
		}
	}
	return parseLinksIn(base, doc)
}

// EVERY link, chrome included. For finding the case-studies section — which lives in the nav, so
// excluding chrome here would hide exactly what we came for. Two callers, two different questions.
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

// The first heading on the page. Case studies almost always name the client in an <h1>, and it is a
// better name source than <title>, which is usually padded with the agency's own branding.
func headingOf(body string) string {
	doc, err := html.Parse(strings.NewReader(body))
	if err != nil {
		return ""
	}
	var h string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if h != "" {
			return
		}
		if n.Type == html.ElementNode && n.Data == "h1" && !isChrome(n) {
			h = textOf(n)
			return
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return h
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
		k := canonicalURL(u)
		if !seen[k] {
			seen[k] = true
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
		k := canonicalURL(u)
		if seen[k] || len(out) >= limit {
			return
		}
		seen[k] = true
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
	Confidence string // "outbound-link" | "outbound-link-page"
	Links      int    // how many times the page linked to it
}

// ExtractClients pulls EVERY company a page points at, not just the most-linked one.
//
// One-per-page was leaving most of the value behind: an "Our Clients" or "Customers" page is a grid
// of thirty logos, and a single case study often names two or three companies. More clients per
// agency is the whole point — each one is another chance that agency has something to answer for.
//
// A name with no link is DROPPED, deliberately. Agencies name-drop companies they never worked with,
// and a name we cannot resolve is both unusable and unverifiable. Only a real outbound link counts.
func ExtractClients(base *url.URL, pageURL, body string) []ClientHit {
	u, err := url.Parse(pageURL)
	if err != nil {
		return nil
	}
	agencyHost := registrableHost(base.Hostname())

	tally := func(links []Link) map[string]*ClientHit {
		out := map[string]*ClientHit{}
		for _, l := range links {
			lu, err := url.Parse(l.URL)
			if err != nil {
				continue
			}
			h := registrableHost(lu.Hostname())
			if h == "" || h == agencyHost || notAClient[h] {
				continue
			}
			if strings.HasSuffix(h, ".gov") || strings.HasSuffix(h, ".edu") {
				continue
			}
			hit := out[h]
			if hit == nil {
				hit = &ClientHit{Domain: h, Confidence: "outbound-link"}
				out[h] = hit
			}
			hit.Links++
			if hit.Name == "" && l.Text != "" && len(l.Text) < 60 {
				hit.Name = l.Text
			}
		}
		return out
	}

	// Content first — that is what stops a footer badge counting as a client. Falling back to the
	// whole page matters just as much: plenty of sites put the client link outside <main>.
	found := tally(parseContentLinks(u, body))
	conf := "outbound-link"
	if len(found) == 0 {
		found = tally(parseLinks(u, body))
		conf = "outbound-link-page"
	}

	var out []ClientHit
	for _, h := range found {
		h.Confidence = conf
		out = append(out, *h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Links > out[j].Links })
	return out
}

// ExtractClient keeps the single-best-answer shape for callers that want one.
func ExtractClient(base *url.URL, pageURL, body string) *ClientHit {
	all := ExtractClients(base, pageURL, body)
	if len(all) == 0 {
		return nil
	}
	return &all[0]
}

// Links out of the markdown r.jina.ai returns — [text](url) and bare URLs. The HTML parser cannot
// read it, and this is the only place markdown ever appears.
var mdLinkRe = regexp.MustCompile(`\[([^\]]*)\]\((https?://[^)\s]+)\)`)
var bareURLRe = regexp.MustCompile(`https?://[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s)"'<>]*`)

func ParseMarkdownLinks(md string) []Link {
	seen := map[string]bool{}
	var out []Link
	for _, m := range mdLinkRe.FindAllStringSubmatch(md, -1) {
		if !seen[m[2]] {
			seen[m[2]] = true
			out = append(out, Link{URL: m[2], Text: strings.TrimSpace(m[1])})
		}
	}
	for _, u := range bareURLRe.FindAllString(md, -1) {
		if !seen[u] {
			seen[u] = true
			out = append(out, Link{URL: u})
		}
	}
	return out
}

// ExtractClientsFromLinks is ExtractClients over a link list that did not come from HTML.
func ExtractClientsFromLinks(base *url.URL, links []Link) []ClientHit {
	agencyHost := registrableHost(base.Hostname())
	found := map[string]*ClientHit{}
	for _, l := range links {
		lu, err := url.Parse(l.URL)
		if err != nil {
			continue
		}
		h := registrableHost(lu.Hostname())
		if h == "" || h == agencyHost || notAClient[h] {
			continue
		}
		if strings.HasSuffix(h, ".gov") || strings.HasSuffix(h, ".edu") {
			continue
		}
		hit := found[h]
		if hit == nil {
			hit = &ClientHit{Domain: h, Confidence: "rendered"}
			found[h] = hit
		}
		hit.Links++
		if hit.Name == "" && l.Text != "" && len(l.Text) < 60 {
			hit.Name = l.Text
		}
	}
	var out []ClientHit
	for _, h := range found {
		out = append(out, *h)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Links > out[j].Links })
	return out
}

// LooksJSRendered reports a page whose content is assembled in the browser: an app shell with a
// framework mount point and almost no links. Without this such a page is indistinguishable from an
// agency that simply has no case studies, and the difference is worth knowing — one is a gap in our
// crawler, the other is a fact about the prospect.
func LooksJSRendered(body string, linkCount int) bool {
	if linkCount > 5 {
		return false
	}
	markers := []string{`id="root"`, `id="__next"`, `id="__nuxt"`, `__NEXT_DATA__`, `ng-version`,
		`data-reactroot`, `id="app"`, `window.__NUXT__`, `<div id="svelte">`}
	for _, m := range markers {
		if strings.Contains(body, m) {
			return true
		}
	}
	return false
}

var titlePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^(?:case study|client story|success story|customer story)\s*[:|–—-]\s*(.+?)\s*(?:[|–—-].*)?$`),
	regexp.MustCompile(`(?i)^how (?:we )?(?:helped|we help|helped)\s+(.+?)\s+(?:to\s+)?[a-z]`),
	regexp.MustCompile(`(?i)^(.+?)\s+(?:case study|success story|client story|customer story)`),
	regexp.MustCompile(`(?i)^(?:working with|partnering with|inside)\s+(.+?)\s*(?:[|–—-].*)?$`),
	regexp.MustCompile(`(?i)^(.+?)(?:'s|’s)\s+(?:journey|story|results|growth|success)`),
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
