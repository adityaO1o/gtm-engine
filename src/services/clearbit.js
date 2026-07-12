// Free company-name -> domain resolver (Clearbit autocomplete — public, no key).
// Powers the Enrich/Prospeo "name + domain" email paths. Cached 24h in-process.

import axios from "axios";
import { log } from "../lib/logger.js";

const cache = new Map(); // lowercased name -> { at, domain }
const DAY = 24 * 3600 * 1000;

export async function companyDomain(name) {
  if (!name) return null;
  const key = name.toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < DAY) return hit.domain;
  try {
    const r = await axios.get("https://autocomplete.clearbit.com/v1/companies/suggest", {
      params: { query: name },
      timeout: 12000,
      validateStatus: () => true,
    });
    const domain = Array.isArray(r.data) && r.data[0]?.domain ? r.data[0].domain : null;
    cache.set(key, { at: Date.now(), domain });
    return domain;
  } catch (e) {
    log.warn("clearbit threw", { err: e.message });
    return null;
  }
}
