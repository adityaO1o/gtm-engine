package main

import (
	"net/url"
	"testing"
)

func mustURL(t *testing.T, s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestRegistrableHost(t *testing.T) {
	cases := map[string]string{
		"www.acme.com":       "acme.com",
		"acme.com":           "acme.com",
		"mail.acme.com":      "acme.com",
		"deep.sub.acme.com":  "acme.com",
		"acme.co.uk":         "acme.co.uk",
		"www.acme.co.uk":     "acme.co.uk",
		"blog.acme.co.uk":    "acme.co.uk",
		"acme.co.in":         "acme.co.in",
		"localhost":          "",
	}
	for in, want := range cases {
		if got := registrableHost(in); got != want {
			t.Errorf("registrableHost(%q) = %q, want %q", in, got, want)
		}
	}
}

// The outbound link is the signal that matters: it yields the client's real DOMAIN, which is what
// the scan needs, instead of a name that still has to be resolved.
func TestExtractClientPrefersOutboundLink(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	body := `<html><head><title>Case Study: Acme | Agency</title></head><body>
		<nav><a href="/case-studies">Case Studies</a><a href="https://twitter.com/agency">Twitter</a></nav>
		<article>
			<h1>How we helped Acme scale outbound</h1>
			<p>We worked with <a href="https://www.acme.com">Acme</a> for 6 months.</p>
			<p>Visit <a href="https://acme.com/pricing">their pricing page</a>.</p>
			<a href="https://facebook.com/acme">fb</a>
		</article>
		<footer><a href="https://agency.com/contact">Contact</a></footer></body></html>`

	hit := ExtractClient(base, "https://agency.com/case-studies/acme", body)
	if hit == nil {
		t.Fatal("no client extracted")
	}
	if hit.Domain != "acme.com" {
		t.Errorf("domain = %q, want acme.com", hit.Domain)
	}
	if hit.Confidence != "outbound-link" {
		t.Errorf("confidence = %q, want outbound-link", hit.Confidence)
	}
}

func TestExtractClientIgnoresSocialAndSelf(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	body := `<html><body>
		<a href="https://linkedin.com/company/agency">LinkedIn</a>
		<a href="https://twitter.com/agency">Twitter</a>
		<a href="https://agency.com/about">About us</a>
		<a href="https://www.agency.com/work">Work</a>
	</body></html>`
	if hit := ExtractClient(base, "https://agency.com/case-studies/x", body); hit != nil && hit.Domain != "" {
		t.Errorf("expected no client domain, got %q", hit.Domain)
	}
}

// A name with no link is now DROPPED. Agencies name-drop companies they never worked with, and an
// unresolvable name is both unusable and unverifiable — only a real outbound link counts.
func TestNameOnlyPagesYieldNothing(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	for _, title := range []string{
		"Case Study: Northwind Traders | Agency",
		"How we helped Contoso double revenue",
		"Fabrikam case study - Agency",
	} {
		body := `<html><head><title>` + title + `</title></head><body><main><h1>` + title +
			`</h1><a href="https://agency.com/x">x</a></main></body></html>`
		if hit := ExtractClient(base, "https://agency.com/case-studies/y", body); hit != nil {
			t.Errorf("%q: expected nothing, got %+v", title, hit)
		}
	}
}

// An "Our Clients" page is a grid of logos and a case study often names several companies. Taking
// only the most-linked one left most of the value on the page.
func TestExtractsEveryClientOnThePage(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	body := `<html><body><main><h2>Our customers</h2>
		<a href="https://acme.com">Acme</a>
		<a href="https://northwind.io">Northwind</a>
		<a href="https://contoso.co.uk">Contoso</a>
		<a href="https://g2.com/agency">Reviews</a>
		<a href="https://agency.com/contact">Contact</a>
	</main></body></html>`
	hits := ExtractClients(base, "https://agency.com/customers", body)
	if len(hits) != 3 {
		t.Fatalf("want 3 clients, got %d: %+v", len(hits), hits)
	}
	got := map[string]bool{}
	for _, h := range hits {
		got[h.Domain] = true
	}
	for _, want := range []string{"acme.com", "northwind.io", "contoso.co.uk"} {
		if !got[want] {
			t.Errorf("missed %s", want)
		}
	}
	if got["g2.com"] || got["agency.com"] {
		t.Error("review site or the agency itself came back as a client")
	}
}

// /customers, /customer-stories and /customers-love are real section names on agency sites.
func TestCustomerSectionPathsAreRecognised(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	home := `<html><body><nav>
		<a href="/customers">Customers</a>
		<a href="/customer-stories">Customer Stories</a>
		<a href="/customers-love">Customers Love</a>
		<a href="/testimonials">Testimonials</a>
	</nav></body></html>`
	got := FindCaseStudyIndexes(base, home, nil)
	if len(got) < 3 {
		t.Fatalf("expected the customer sections to be found, got %v", got)
	}
}

// A framework shell with no links is not the same fact as "this agency names no clients".
func TestDetectsJSRenderedShell(t *testing.T) {
	shell := `<html><body><div id="__next"></div><script src="/app.js"></script></body></html>`
	if !LooksJSRendered(shell, 0) {
		t.Error("did not recognise a Next.js shell")
	}
	real := `<html><body><main><p>lots of content</p></main></body></html>`
	if LooksJSRendered(real, 40) {
		t.Error("a normal page was called JS-rendered")
	}
}

func TestFindCaseStudyIndexes(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	home := `<html><body><nav>
		<a href="/about">About</a>
		<a href="/case-studies">Case Studies</a>
		<a href="/blog">Blog</a>
		<a href="https://other.com/work">Someone else's work</a>
	</nav></body></html>`
	got := FindCaseStudyIndexes(base, home, []string{"https://agency.com/our-work"})
	if len(got) == 0 {
		t.Fatal("found no index pages")
	}
	found := map[string]bool{}
	for _, g := range got {
		found[g] = true
	}
	if !found["https://agency.com/case-studies"] {
		t.Errorf("missed /case-studies, got %v", got)
	}
	for _, g := range got {
		if u, _ := url.Parse(g); u.Hostname() == "other.com" {
			t.Errorf("picked up a third-party URL: %v", got)
		}
	}
}

func TestFindCaseStudyPages(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	index := `<html><body>
		<a href="/case-studies">All case studies</a>
		<a href="/case-studies/acme">Acme</a>
		<a href="/case-studies/northwind">Northwind</a>
		<a href="/blog/seo-tips">Blog post</a>
	</body></html>`
	got := FindCaseStudyPages(base, index, nil, 40)
	if len(got) != 2 {
		t.Fatalf("expected 2 case studies, got %d: %v", len(got), got)
	}
	for _, g := range got {
		if g == "https://agency.com/case-studies" {
			t.Error("index page returned as an individual case study")
		}
	}
}

func TestParseSitemap(t *testing.T) {
	xml := `<?xml version="1.0"?><urlset>
		<url><loc>https://agency.com/</loc></url>
		<url><loc> https://agency.com/case-studies/acme </loc></url>
	</urlset>`
	got := ParseSitemap(xml)
	if len(got) != 2 || got[1] != "https://agency.com/case-studies/acme" {
		t.Errorf("ParseSitemap = %v", got)
	}
}

// The real failure from the first 50-agency run: a G2 badge sat in the footer of every page, so it
// out-counted the single body link that actually named the client — and g2.com became the "client"
// of four different agencies.
func TestExtractClientIgnoresChrome(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	body := `<html><body>
		<header><a href="https://g2.com/agency">Reviews</a><a href="https://clutch.co/agency">Clutch</a></header>
		<main>
			<h1>How we helped Hypefy scale outbound</h1>
			<p>We partnered with <a href="https://hypefy.ai">Hypefy</a>.</p>
		</main>
		<footer>
			<a href="https://g2.com/agency">G2</a><a href="https://g2.com/reviews">More reviews</a>
			<a href="https://g2.com/badge">Badge</a><a href="https://clutch.co/x">Clutch</a>
		</footer></body></html>`

	hit := ExtractClient(base, "https://agency.com/case-studies/hypefy", body)
	if hit == nil {
		t.Fatal("no client extracted")
	}
	if hit.Domain != "hypefy.ai" {
		t.Errorf("domain = %q, want hypefy.ai (chrome links must not win)", hit.Domain)
	}
}

func TestReviewAndPressSitesAreNeverClients(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	for _, junk := range []string{"g2.com", "clutch.co", "hbr.org", "entrepreneur.com", "statista.com", "capterra.com"} {
		body := `<html><body><main><p>As seen on <a href="https://` + junk + `/x">them</a>.</p></main></body></html>`
		if hit := ExtractClient(base, "https://agency.com/case-studies/x", body); hit != nil && hit.Domain != "" {
			t.Errorf("%s was returned as a client domain", junk)
		}
	}
}


// The regression that took inboxkit.com from 6 clients to 0: the client link sits outside <main>, so
// scoping to content found nothing and the extractor gave up instead of looking wider.
func TestFallsBackToWholePageWhenContentHasNoClient(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	body := `<html><body>
		<main><h1>Client success</h1><p><a href="/contact">Talk to us</a></p></main>
		<section class="cta-band"><p>Visit <a href="https://leadhaste.com">Leadhaste</a></p></section>
	</body></html>`
	hit := ExtractClient(base, "https://agency.com/case-studies/leadhaste", body)
	if hit == nil || hit.Domain != "leadhaste.com" {
		t.Fatalf("want leadhaste.com from outside <main>, got %+v", hit)
	}
}

// isChrome matched class substrings, so a hero called "banner" or a section called "navy" deleted
// the page body on exactly the site builders agencies use.
func TestChromeMatchingIsTokenNotSubstring(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	body := `<html><body>
		<div class="hero-banner section-navy"><p>We helped <a href="https://cymate.io">Cymate</a></p></div>
		<footer><a href="https://g2.com/x">G2</a><a href="https://g2.com/y">G2</a></footer>
	</body></html>`
	hit := ExtractClient(base, "https://agency.com/case-studies/cymate", body)
	if hit == nil || hit.Domain != "cymate.io" {
		t.Fatalf("want cymate.io — 'banner'/'navy' are not chrome, got %+v", hit)
	}
}

// www and non-www are the same page. The sitemap lists one form and the index page's relative links
// resolve to the other, so deduping on the raw string fetched every case study twice — inboxkit.com
// reported 12 pages for its 6.
func TestCaseStudyDedupeIgnoresWww(t *testing.T) {
	base := mustURL(t, "https://inboxkit.com")
	index := `<html><body>
		<a href="/case-studies/cymate">Cymate</a>
		<a href="/case-studies/anevo">Anevo</a>
	</body></html>`
	sitemap := []string{
		"https://www.inboxkit.com/case-studies/cymate",
		"https://www.inboxkit.com/case-studies/anevo/",
	}
	got := FindCaseStudyPages(base, index, sitemap, 40)
	if len(got) != 2 {
		t.Fatalf("want 2 unique pages, got %d: %v", len(got), got)
	}
}
