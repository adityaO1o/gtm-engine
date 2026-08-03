// Confirms a candidate domain is a LIVE sending-domain that redirects back into the seed company's
// real site — the actual proof point (registered-but-parked domains and coincidental prefix/suffix
// hits are noise; only a domain whose final redirect destination matches the seed is a real lead).
import axios from "axios";
import { config } from "../config.js";

const stripWww = (host) => String(host || "").toLowerCase().replace(/^www\./, "");

// axios (via the follow-redirects lib on its default Node adapter) exposes the final URL the chain
// landed on at response.request.res.responseUrl — that's the only reliable way to read it post-redirect.
async function fetchFinalHost(url) {
  const r = await axios.get(url, {
    maxRedirects: 5,
    timeout: config.scanRedirectTimeoutMs,
    validateStatus: () => true,
    maxContentLength: 200_000, // don't pull down full pages, just enough to complete the redirect chain
    headers: { "User-Agent": "Mozilla/5.0 (compatible; InboxKitScan/1.0)" },
  });
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
