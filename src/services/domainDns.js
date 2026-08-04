// Cheap DNS pre-filter for the domain-prospecting scan — "does this candidate have a web-reachable
// address at all" before spending an HTTP round-trip on it.
//
// Uses dns.lookup (getaddrinfo, the SAME system resolver path axios/HTTP uses) rather than
// dns.resolve4 (raw c-ares UDP query direct to a DNS server). Verified empirically: some network
// environments (this one included) allow normal outbound DNS-via-getaddrinfo but block raw UDP:53 to
// arbitrary resolvers, which makes dns.resolve4 fail with ECONNREFUSED across the board — a false
// "nothing is registered" reading. dns.lookup is the portable choice. It also happens to be the
// semantically correct check here: a domain with only an MX record and no A/AAAA can't serve HTTP
// anyway, so it's out of scope for the redirect-check stage regardless of whether it "exists".
//
// The tradeoff: dns.lookup runs on libuv's threadpool (default size 4), so raw concurrency is capped
// unless UV_THREADPOOL_SIZE is raised — set it (e.g. 128) in the process environment / Dockerfile.
// See .env.example.
import dns from "node:dns";
import axios from "axios";
import { config } from "../config.js";

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

// true = resolves to an address -> worth an HTTP redirect check. false = unregistered / no web
// presence / ambiguous (timeout etc — dropped rather than retried; this is a discovery scan, not a
// deliverability audit, so occasionally missing a slow-resolving domain is an acceptable speed trade).
export async function domainHasDns(domain) {
  try {
    await withTimeout(dns.promises.lookup(domain), config.scanDnsTimeoutMs);
    return true;
  } catch {
    return false;
  }
}
