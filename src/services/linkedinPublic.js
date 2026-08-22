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
import { HttpsProxyAgent } from "https-proxy-agent";
import { nextWorkingAgent, poolSize } from "../lib/proxies.js";
import { config } from "../config.js";
import { log } from "../lib/logger.js";

// The ROTATING Webshare gateway — a different exit IP on every request. That is exactly what this
// job needs: LinkedIn answers 999 per exit address, so a fresh IP per attempt is the difference
// between a third of profiles resolving and none of them.
//
// It is also why the first run reported 752 blocked in 402 milliseconds: this reached for the
// STATIC pool (PROXIES / proxies.txt), which is empty on the server — proxies.txt is gitignored and
// never reaches the image, and the server runs the gateway instead. An empty pool returned before a
// single request was made, and every profile was recorded as blocked.
const ROTATING = (() => {
  const w = config.webshare;
  const hostPort = w.gateway || (w.host ? `${w.host}:${w.port}` : "");
  if (!hostPort || !w.username) return null;
  return `http://${encodeURIComponent(w.username)}:${encodeURIComponent(w.password)}@${hostPort}`;
})();
// A gateway that has run out of bandwidth answers 402 to EVERYTHING, including the proxy's own
// health check — so it is not a per-request failure to retry, it is the gateway being unusable for
// the rest of the process. Benching it on the first 402 stops every later attempt from burning a
// round-trip on a wall, and lets the static pool take over.
let rotatingAgent = null;
let rotatingDead = false;
const rotating = () => {
  if (!ROTATING || rotatingDead) return null;
  if (!rotatingAgent) rotatingAgent = new HttpsProxyAgent(ROTATING);
  return rotatingAgent;
};
export const hasProxies = () => !!ROTATING || poolSize() > 0;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const stats = { ok: 0, blocked: 0, proxyErr: 0, miss: 0, noProxy: 0, bandwidth: 0, other: 0 };
export const linkedinPublicStats = () => ({ ...stats, rotating: !!ROTATING && !rotatingDead, poolSize: poolSize() });

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
  if (!hasProxies()) { stats.noProxy++; return null; }

  for (let i = 0; i < attempts; i++) {
    // Prefer the rotating gateway: it hands out a fresh exit IP per request with no validation
    // round-trip, so a retry after a 999 genuinely lands somewhere else. The validated static pool
    // is the fallback for local runs, where proxies.txt exists and the gateway usually does not.
    let agent = rotating(), viaRotating = !!agent;
    if (!agent) {
      try { ({ agent } = await nextWorkingAgent()); } catch { stats.proxyErr++; break; }
      viaRotating = false;
    }
    try {
      const r = await axios.get(`https://www.linkedin.com/in/${vanity}`, {
        httpsAgent: agent,
        proxy: false,
        timeout: 25000,
        validateStatus: () => true,
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,application/xhtml+xml" },
      });
      if (r.status === 402) {                                     // gateway bandwidth exhausted
        stats.bandwidth++;
        if (viaRotating) { rotatingDead = true; log.warn("webshare gateway out of bandwidth — falling back to the static pool"); }
        continue;
      }
      if (r.status === 999) { stats.blocked++; continue; }        // blocked exit IP — try another
      if (r.status === 407 || r.status === 403) { stats.proxyErr++; continue; }
      // Anything else is still a failure and must be counted, or a run reports zeros everywhere and
      // there is no way to tell what went wrong.
      if (r.status !== 200 || typeof r.data !== "string") { stats.other++; continue; }
      const out = extract(r.data);
      if (out.followers == null && !out.connections_raw) { stats.miss++; continue; }
      stats.ok++;
      return { ...out, vanity, at: new Date() };
    } catch { stats.proxyErr++; }
  }
  return null;
}
