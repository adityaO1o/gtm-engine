// HTTP Basic Auth for the dashboard + /api/* (protects prospect data behind a login).
// /enrich stays on the ingest-token instead (Trigify can't do basic auth).

import { config } from "../config.js";
import { log } from "./logger.js";

let warned = false;

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
    // constant-ish comparison
    if (user === config.dashUser && pass === config.dashPass) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="GTM Engine", charset="UTF-8"');
  return res.status(401).send("Authentication required");
}
