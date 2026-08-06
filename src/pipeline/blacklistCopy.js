// The blacklist-outreach sequence pushed into SendKit, plus the per-lead variables it needs.
//
// SendKit resolves {{variable}} against the lead's standard + custom fields, so every unrecognized
// key we send on a lead (blacklistedDomainCount, domain1..4, …) becomes usable in this copy.
//
// Two deliberate deviations from the original draft, per the brief:
//   - No {{calendlyLink}} — we don't have one, so that CTA is reworded to a plain reply ask.
//   - No {{clientName1/2}} — we have no source for a prospect's own client names, and guessing them
//     into a real cold email is worse than not naming them, so email 2 uses a generic line.
export const SENDER_NAME = "Abbas Somji";

// Body is HTML (SendKit sends `body` as HTML). Keep it plain and text-like — no styling, so it reads
// like a hand-written email rather than a marketing blast.
const p = (s) => `<p>${s}</p>`;

const EMAIL_1 = [
  p("Hey {{firstName}},"),
  p("Pulled a scan on {{companyName}}'s {{secondaryDomainCount}} secondary outbound domains yesterday and {{blacklistedDomainCount}} of them are sitting on blacklists right now. A few examples:"),
  p("{{domain1}}, {{domain2}}, {{domain3}}, {{domain4}}"),
  p("Won't kill deliverability overnight, but anything sending through those domains is probably landing in spam more than it should already."),
  p("We scanned your whole secondary footprint, not just these four. And since these are blacklisted, on InboxKit you can just rotate them out and keep tracking the rest so this doesn't sneak up again."),
  p("Can run the same check across your other domains too, that's usually where the ugly stuff hides."),
  p("Happy to send the full report over, just reply."),
  p("{{senderName}}"),
].join("\n");

const EMAIL_2 = [
  p("{{firstName}}, thought I'd just send the whole report over rather than sit on it."),
  p("Also happy to run the same audit on any other domains you're sending from, so you catch anything before your prospects do."),
  p("And if any of these domains are worth keeping alive, you can rotate them with us instead of burning them."),
  p("Let me know and I'll share the details."),
  p("Talk soon,<br />{{senderName}}"),
].join("\n");

const EMAIL_3 = [
  p("{{firstName}}, last one from me."),
  p("The {{blacklistedDomainCount}} domains I flagged were just what surfaced first. If you're sending at real scale the actual number is probably higher, and the rest of your sending setup won't all be clean either."),
  p("If deliverability isn't the fire right now, no stress, I'll drop it here."),
  p('Otherwise just reply "send it" and the full breakdown is yours.'),
  p("{{senderName}}"),
].join("\n");

// Day 0 → wait 3 → Day 3 → wait 3 → Day 6
export const BLACKLIST_SEQUENCE = [
  { type: "email", order: 0, name: "Email 1 — Ran a check on your domains", subject: "Ran a check on your domains", body: EMAIL_1 },
  { type: "wait", order: 1, name: "Wait 3 days", waitDays: 3 },
  { type: "email", order: 2, name: "Email 2 — Full report", subject: "Re: Ran a check on your domains", body: EMAIL_2 },
  { type: "wait", order: 3, name: "Wait 3 days", waitDays: 3 },
  { type: "email", order: 4, name: "Email 3 — Last one", subject: "Re: Ran a check on your domains", body: EMAIL_3 },
];

// Build the SendKit lead payload for one person at one prospect company. Standard fields are mapped
// by SendKit; everything else lands as a custom field and is addressable as {{key}} in the copy.
export function leadPayload(person, target) {
  const bl = target.blacklistedDomains || [];
  const top = bl.slice(0, 4).map((d) => d.domain);
  return {
    email: person.email,
    firstName: person.first_name || (person.name || "").split(" ")[0] || "",
    lastName: person.last_name || (person.name || "").split(" ").slice(1).join(" ") || "",
    companyName: target.companyName || target.seed,
    jobTitle: person.job_title || "",
    linkedinUrl: person.linkedin_url || "",
    // custom fields used by the copy
    secondaryDomainCount: String(target.redirectCount ?? bl.length),
    blacklistedDomainCount: String(target.blacklistedCount ?? bl.length),
    domain1: top[0] || "", domain2: top[1] || "", domain3: top[2] || "", domain4: top[3] || "",
    // full list (max 10) for the report / manual use
    blacklistedDomains: bl.slice(0, 10).map((d) => d.domain).join(", "),
    seedDomain: target.seed,
    senderName: SENDER_NAME,
    tags: ["gtm-auto", "blacklist-campaign"],
  };
}
