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

	tally := func(links []Link) (string, map[string]string) {
		counts := map[string]int{}
		names := map[string]string{}
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
		return best, names
	}

	// Content first: that is what stops a footer badge outranking the one link in the body. But
	// preferring content must never mean IGNORING everything else — plenty of sites put the client
	// link outside <main>, and treating chrome-exclusion as a hard filter took a working extractor
	// (6 clients from inboxkit.com) to zero.
	if best, names := tally(parseContentLinks(u, body)); best != "" {
		return &ClientHit{Domain: best, Name: names[best], Confidence: "outbound-link"}
	}
	if best, names := tally(parseLinks(u, body)); best != "" {
		return &ClientHit{Domain: best, Name: names[best], Confidence: "outbound-link-page"}
	}

	// Nothing linked out. Fall back to a NAME, which downstream must still resolve to a domain — the
	// heading first, since <title> is usually padded with the agency's own branding.
	for _, src := range []string{headingOf(body), titleOf(body)} {
		if src == "" {
			continue
		}
		if name := clientNameFromTitle(src); name != "" {
			return &ClientHit{Name: name, Confidence: "title"}
		}
	}
	return nil
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
