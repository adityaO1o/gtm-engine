// HTTP Basic Auth for the dashboard + /api/* (protects prospect data behind a login).
// /enrich stays on the ingest-token instead (Trigify can't do basic auth).

import crypto from "node:crypto";
import { config } from "../config.js";
import { log } from "./logger.js";

let warned = false;

// Constant-time string compare — no early-exit, so an attacker can't time-guess the secret.
export function safeEqual(a = "", b = "") {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still do a comparison to keep timing flat
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

export function basicAuth(req, res, next) {
  // If no dashboard creds are configured, leave it open but warn once — never silently expose.
  if (!config.dashUser || !config.dashPass) {
    if (!warned) {
      log.warn("dashboard is OPEN — set DASH_USER and DASH_PASS to lock it");
      warned = true;
    }
    return next();
  }

  const hdr = req.headers.authorization || "";
  const [scheme, encoded] = hdr.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (safeEqual(user, config.dashUser) && safeEqual(pass, config.dashPass)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="GTM Engine", charset="UTF-8"');
  return res.status(401).send("Authentication required");
}
