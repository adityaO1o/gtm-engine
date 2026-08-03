// Confirms a candidate domain is a LIVE sending-domain that redirects back into the seed company's
// real site — the actual proof point (registered-but-parked domains and coincidental prefix/suffix
// hits are noise; only a domain whose final redirect destination matches the seed is a real lead).
import axios from "axios";
import { config } from "../config.js";

const stripWww = (host) => String(host || "").toLowerCase().replace(/^www\./, "");

// axios (via the follow-redirects lib on its default Node adapter) exposes the final URL the chain
// landed on at response.request.res.responseUrl — that's the only reliable way to read it post-redirect.
//
// responseType: "stream" + immediately destroying the body: we only need the final redirect URL, not
// the page content, and axios's promise already resolves once the (fully-redirected) response headers
// arrive — nothing here waits on the body. A previous version capped maxContentLength at 200KB to
// "avoid pulling down full pages", but real landing pages routinely exceed that (verified: inboxkit.com
// itself is 223KB) — axios aborted mid-download on every real hit and got silently swallowed as "no
// redirect", a false negative on every single real lead. Not buffering the body at all fixes both the
// correctness bug and is faster than the capped-buffer version ever was.
async function fetchFinalHost(url) {
  const r = await axios.get(url, {
    maxRedirects: 5,
    timeout: config.scanRedirectTimeoutMs,
    validateStatus: () => true,
    responseType: "stream",
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InboxKitScan/1.0)" },
  });
  r.data.destroy();
  const finalUrl = r.request?.res?.responseUrl || url;
  try { return new URL(finalUrl).hostname; } catch { return null; }
}

// -> true if `candidate` is live and its redirect chain ends on `seedDomain` (or www.seedDomain).
export async function redirectsToSeed(candidate, seedDomain) {
  const seed = stripWww(seedDomain);
  for (const scheme of ["https://", "http://"]) {
    try {
      const host = await fetchFinalHost(scheme + candidate);
      if (host && stripWww(host) === seed) return true;
      if (host) return false; // resolved to something else — no point trying the other scheme
    } catch { /* this scheme failed — try the next one */ }
  }
  return false;
}
