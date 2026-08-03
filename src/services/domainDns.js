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
import { config } from "../config.js";

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("dns timeout"), { code: "ETIMEOUT" })), ms)),
  ]);
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
