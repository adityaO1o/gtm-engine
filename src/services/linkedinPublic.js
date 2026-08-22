// Follower and connection counts, read straight off the public LinkedIn profile page.
//
// LinkedIn hides a person's connection LIST and follower LIST — no API exposes either, and no
// amount of paying changes that. But the COUNTS are printed on the logged-out profile page, and
// that is the only number the creator gates actually need: a connection count caps at "500+" and so
// cannot separate a well-connected consultant from a real creator, while the follower count can.
//
// PND has no endpoint for this at all (probed: get-profile-connection-follower-count,
// get-profile-follower-count, get-social-count — none exist), and its profile endpoint returns
// skills, positions and education but no audience numbers. So this is not a cheaper version of a
// paid call; it is the only version.
//
// Measured behaviour, which the retry logic is built around:
//   * a good fetch returns 200 with "3K followers" / "12M followers" in the markup;
//   * roughly a third come back 999 — LinkedIn's block code — and the SAME profile succeeds on a
//     different exit IP, so a 999 is a proxy problem, not a missing profile;
//   * a dead proxy answers 407, which is also worth retrying elsewhere.
// The counts are rounded by LinkedIn itself ("3K", not 3,214). That is fine for a threshold and
// must not be presented as exact.
import axios from "axios";
import { nextWorkingAgent, poolSize } from "../lib/proxies.js";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const stats = { ok: 0, blocked: 0, proxyErr: 0, miss: 0 };
export const linkedinPublicStats = () => ({ ...stats });

// "3K" -> 3000, "12M" -> 12000000, "1,234" -> 1234. LinkedIn rounds anything above a thousand, so
// this is a band, not a measurement.
export function parseCount(raw) {
  if (!raw) return null;
  const m = String(raw).trim().replace(/,/g, "").match(/^([\d.]+)\s*([KkMm])?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = /k/i.test(m[2] || "") ? 1e3 : /m/i.test(m[2] || "") ? 1e6 : 1;
  return Math.round(n * mult);
}

function extract(html) {
  const followersRaw = (html.match(/([\d.,]+\s*[KkMm]?)\s*followers?\b/i) || [])[1] || null;
  const connectionsRaw = (html.match(/([\d.,]+\s*[KkMm]?\+?)\s*connections?\b/i) || [])[1] || null;
  return {
    followers: parseCount(followersRaw),
    followers_raw: followersRaw ? followersRaw.trim() : null,
    // Almost always "500+". Kept for completeness, never used as an audience measure.
    connections_raw: connectionsRaw ? connectionsRaw.trim() : null,
    connections_capped: /\+/.test(connectionsRaw || ""),
  };
}

// One profile. Rotates a fresh exit IP per attempt, because a 999 is about the IP and not the URL.
export async function fetchPublicProfile(url, { attempts = 4 } = {}) {
  const vanity = String(url || "").match(/linkedin\.com\/in\/([^/?#]+)/i)?.[1];
  if (!vanity) return null;
  if (!poolSize()) return null;

  for (let i = 0; i < attempts; i++) {
    // The pool validates the specific proxy right before handing it over and advances its own
    // cursor, so each attempt genuinely lands on a different, live exit IP.
    let agent;
    try { ({ agent } = await nextWorkingAgent()); } catch { stats.proxyErr++; break; }
    try {
      const r = await axios.get(`https://www.linkedin.com/in/${vanity}`, {
        httpsAgent: agent,
        proxy: false,
        timeout: 25000,
        validateStatus: () => true,
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,application/xhtml+xml" },
      });
      if (r.status === 999) { stats.blocked++; continue; }        // blocked exit IP — try another
      if (r.status === 407 || r.status === 403) { stats.proxyErr++; continue; }
      if (r.status !== 200 || typeof r.data !== "string") continue;
      const out = extract(r.data);
      if (out.followers == null && !out.connections_raw) { stats.miss++; continue; }
      stats.ok++;
      return { ...out, vanity, at: new Date() };
    } catch { stats.proxyErr++; }
  }
  return null;
}
