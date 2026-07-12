// Data-quality guards (from live-log bug review).

// G1: LinkedIn company pages are not people.
export const isCompanyPage = (url = "") => /\/company\//i.test(url);

// G3: personal mailbox domains — for B2B cold outreach these are usually not the work inbox.
const PERSONAL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "aol.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "gmx.com",
  "mail.com", "yandex.com", "hey.com",
]);
export const emailDomain = (email = "") => (email.split("@")[1] || "").toLowerCase();
export const isPersonalDomain = (email = "") => PERSONAL.has(emailDomain(email));

// G2: does the email's local-part actually belong to this person?
// Prospeo/Enrich sometimes return the WRONG person's email (e.g. "Tayo Kolade" -> smogey@).
// Sending to those wrecks sender reputation, so a mismatch is held for review.
export function nameMatchesEmail(name = "", email = "") {
  const local = (email.split("@")[0] || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!local) return false;
  const tokens = name.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length >= 2);
  if (!tokens.length) return true; // nothing to check against — don't block
  const first = tokens[0], last = tokens[tokens.length - 1];
  // any real name token (>=3 chars) appears in the local part  (patrick, seraj.ahmed, bneema<-neema)
  if (tokens.some((t) => t.length >= 3 && local.includes(t))) return true;
  // initials  (first+last / last+first / first-initial+last)
  const fi = first[0], li = last[0];
  if (local.startsWith(fi + li) || local.startsWith(li + fi)) return true;
  if (last.length >= 3 && local.startsWith(fi + last)) return true;
  if (first.length >= 3 && local.startsWith(li + first)) return true;
  return false;
}
