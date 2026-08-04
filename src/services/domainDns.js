// Cheap DNS pre-filter for the domain-prospecting scan — "does this candidate have a web-reachable
// address at all" before spending an HTTP round-trip on it.
//
// Queries big public resolvers (8.8.8.8 / 1.1.1.1) DIRECTLY over raw UDP:53 via dns.resolve4, NOT
// dns.lookup. Why this matters, learned the hard way:
//   - dns.lookup (getaddrinfo) funnels every query through the ONE resolver in /etc/resolv.conf — on
//     a Docker/Dokploy host that's the tiny embedded forwarder at 127.0.0.11. It also runs on libuv's
//     threadpool. At the scan's concurrency (hundreds) that forwarder + threadpool choked and started
//     TIMING OUT on real domains, i.e. reporting "doesn't exist" for domains that do — a 24k-candidate
//     scan confirmed 0 redirects when ~500 were real. The bottleneck was never DNS itself; it was
//     hammering one small resolver we don't control.
//   - dns.resolve4 with a custom Resolver talks straight to 8.8.8.8 / 1.1.1.1 (raw UDP:53). Those are
//     industrial resolvers that never choke at this volume, and c-ares does NOT use the threadpool, so
//     concurrency isn't capped. The deploy host's /api/domainscan/dnstest confirmed raw UDP:53 to
//     these is open here (it isn't everywhere — hence the self-test before committing to this).
// Queries are spread across both providers (by candidate index) to halve the per-resolver load, with
// one cheap retry on the other provider before giving up.
import dns from "node:dns";
import axios from "axios";
import { config } from "../config.js";

// Two independent Resolver instances, one per provider, each pinned to its own servers. Reused across
// all lookups (creating one per query would leak sockets). tries:1 — we do our own cross-provider retry.
const RESOLVERS = [
  { name: "google", r: makeResolver(["8.8.8.8", "8.8.4.4"]) },
  { name: "cloudflare", r: makeResolver(["1.1.1.1", "1.0.0.1"]) },
];
function makeResolver(servers) {
  const r = new dns.promises.Resolver({ timeout: Math.max(1500, config.scanDnsTimeoutMs), tries: 1 });
  r.setServers(servers);
  return r;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("dns timeout"), { code: "ETIMEOUT" })), ms)),
  ]);
}

// ── DNS connectivity self-test ────────────────────────────────────────────────────────────────
// Answers the one question that decides how the scan's DNS pre-filter should work on THIS host:
// can we bypass the tiny Docker/OS resolver and talk to a big public resolver (8.8.8.8 / 1.1.1.1)
// directly? Three transports are tested from the deploy host itself:
//   1. dns.lookup (getaddrinfo) — what the scan uses now; goes through the Docker/OS resolver.
//   2. dns.resolve4 via a custom Resolver pointed at 8.8.8.8 / 1.1.1.1 — RAW UDP:53 to a public
//      resolver. If this works, it's the fix: no threadpool cap, a resolver that never chokes.
//   3. DNS-over-HTTPS (port 443) to dns.google — the fallback when raw UDP:53 is firewalled, since
//      it looks like ordinary HTTPS and firewalls don't block it.
async function timed(fn) {
  const t0 = Date.now();
  try { const v = await fn(); return { ok: true, ms: Date.now() - t0, sample: v }; }
  catch (e) { return { ok: false, ms: Date.now() - t0, error: e.code || e.message }; }
}

async function resolveVia(servers) {
  const r = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
  r.setServers(servers);
  const ips = await r.resolve4("google.com");
  return ips?.[0];
}

async function doh(url, host) {
  const r = await axios.get(url, {
    params: { name: "google.com", type: "A" },
    headers: { accept: "application/dns-json" },
    timeout: 5000, validateStatus: () => true,
  });
  if (r.status !== 200 || !(r.data?.Answer?.length)) throw new Error(`doh ${host} status ${r.status}`);
  return r.data.Answer.find((a) => a.type === 1)?.data;
}

export async function dnsSelfTest() {
  const [osLookup, caresDefault, udpGoogle, udpCloudflare, dohGoogle, dohCloudflare] = await Promise.all([
    timed(() => dns.promises.lookup("google.com").then((r) => r.address)),
    timed(() => dns.promises.resolve4("google.com").then((r) => r[0])),
    timed(() => resolveVia(["8.8.8.8", "8.8.4.4"])),
    timed(() => resolveVia(["1.1.1.1", "1.0.0.1"])),
    timed(() => doh("https://dns.google/resolve", "google")),
    timed(() => doh("https://cloudflare-dns.com/dns-query", "cloudflare")),
  ]);
  const udpOpen = udpGoogle.ok || udpCloudflare.ok;
  const dohOpen = dohGoogle.ok || dohCloudflare.ok;
  let recommendation;
  if (udpOpen) {
    recommendation = "RAW UDP:53 to a public resolver WORKS — switch the DNS pre-filter to dns.resolve via 8.8.8.8/1.1.1.1. Bypasses the Docker resolver entirely, no threadpool cap, won't choke at high concurrency.";
  } else if (dohOpen) {
    recommendation = "Raw UDP:53 is BLOCKED, but DNS-over-HTTPS (443) WORKS — use DoH against dns.google / cloudflare for the DNS pre-filter (or skip DNS and go straight to the HTTP redirect check at lower concurrency).";
  } else {
    recommendation = "Neither raw UDP:53 nor DoH reached a public resolver — only the OS/Docker resolver is available. Best option: drop the DNS pre-filter and do the HTTP redirect check directly at a modest concurrency (~50-80).";
  }
  return { osLookup, caresDefault, udp53_google: udpGoogle, udp53_cloudflare: udpCloudflare, doh_google: dohGoogle, doh_cloudflare: dohCloudflare, udpOpen, dohOpen, recommendation };
}

// NXDOMAIN / NODATA are AUTHORITATIVE "this name has no A record" answers — a definite false, no point
// retrying on the other provider. Everything else (timeout, SERVFAIL, refused) is a transient/transport
// failure worth one retry elsewhere before we conclude "dead".
const AUTHORITATIVE_MISS = new Set(["ENOTFOUND", "ENODATA", "NXDOMAIN"]);

async function resolveOnce(resolver, domain) {
  await withTimeout(resolver.resolve4(domain), config.scanDnsTimeoutMs);
}

// true = resolves to an address -> worth an HTTP redirect check. false = unregistered / no web
// presence. `index` spreads load across the two providers (even -> google first, odd -> cloudflare
// first); on a transient failure we try the OTHER provider once before giving up. A definite
// NXDOMAIN/NODATA short-circuits to false immediately.
export async function domainHasDns(domain, index = 0) {
  const order = index % 2 === 0 ? [RESOLVERS[0], RESOLVERS[1]] : [RESOLVERS[1], RESOLVERS[0]];
  for (let i = 0; i < order.length; i++) {
    try {
      await resolveOnce(order[i].r, domain);
      return true;
    } catch (e) {
      if (AUTHORITATIVE_MISS.has(e.code)) return false; // definite "no such record" — don't retry
      // transient (timeout/SERVFAIL/refused) — fall through to the other provider, then give up
    }
  }
  return false;
}
