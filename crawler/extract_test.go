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

// No outbound link at all — fall back to the title, which yields a NAME only. Downstream must not
// treat that as a domain.
func TestExtractClientTitleFallback(t *testing.T) {
	base := mustURL(t, "https://agency.com")
	cases := map[string]string{
		"Case Study: Northwind Traders | Agency":   "Northwind Traders",
		"How we helped Contoso double revenue":     "Contoso",
		"Fabrikam case study - Agency":             "Fabrikam",
	}
	for title, want := range cases {
		body := `<html><head><title>` + title + `</title></head><body><a href="https://agency.com/x">x</a></body></html>`
		hit := ExtractClient(base, "https://agency.com/case-studies/y", body)
		if hit == nil {
			t.Errorf("%q: no hit", title)
			continue
		}
		if hit.Domain != "" {
			t.Errorf("%q: got a domain %q from a title — must stay unresolved", title, hit.Domain)
		}
		if hit.Name != want {
			t.Errorf("%q: name = %q, want %q", title, hit.Name, want)
		}
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
