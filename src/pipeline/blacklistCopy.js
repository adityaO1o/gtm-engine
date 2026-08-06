// The blacklist-outreach sequence pushed into SendKit, plus the per-lead variables it needs.
//
// SendKit resolves {{variable}} against the lead's standard + custom fields, so every unrecognized
// key we send on a lead (blacklistedDomainCount, domain1..4, …) becomes usable in this copy.
//
// The copy below is the approved script, kept verbatim — including "Or grab a slot:" in email 3 with
// nothing after it (there is no booking link yet; keeping it was an explicit call) and email 2's
// hardcoded "Talk soon, Abbas Somji" sign-off. Don't "tidy" these without asking.
export const SENDER_NAME = "Abbas Somji";

// The single standing SendKit campaign every run's qualified leads are added to. Resolved by NAME at
// push time, so pointing the engine at it needs no env var or redeploy.
export const BLACKLIST_CAMPAIGN_NAME = "Blacklist Campaign";

// Body is HTML (SendKit sends `body` as HTML). Keep it plain and text-like — no styling, so it reads
// like a hand-written email rather than a marketing blast.
const p = (s) => `<p>${s}</p>`;

const SUBJECT = "Ran a check on your domains";

const EMAIL_1 = [
  p("Hey {{firstName}},"),
  p("Pulled a scan on {{companyName}}'s {{secondaryDomainCount}} secondary outbound domains yesterday and {{blacklistedDomainCount}} of them are sitting on SURBL right now. Few examples:"),
  p("{{domain1}}, {{domain2}}, {{domain3}}, {{domain4}}"),
  p("Won't kill deliverability overnight, but anything sending through those domains is probably landing in spam more than it should already."),
  p("We scanned your whole secondary footprint, not just these four. And since these are blacklisted, on InboxKit you can just rotate them out and keep tracking the rest so this doesn't sneak up again."),
  p("Can run the same check across your client setups too, that's usually where the ugly stuff hides."),
  p("Happy to send the full report over, just reply."),
  p("{{senderName}}"),
].join("\n");

const EMAIL_2 = [
  p("{{firstName}}, thought I'd just send the whole report over rather than sit on it."),
  p("Also happy to run the same audit for your clients, for a start, so you catch anything on their side before they do."),
  p("And if any of these domains are worth keeping alive, you can rotate them with us instead of burning them."),
  p("Let me know and I'll share the details."),
  p("Talk soon, Abbas Somji"),
].join("\n");

const EMAIL_3 = [
  p("{{firstName}}, last one from me."),
  p("The {{blacklistedDomainCount}} domains I flagged were just what surfaced first. If you're sending at real scale the actual number is probably higher, and your client setups won't all be clean either."),
  p("If deliverability isn't the fire right now, no stress, I'll drop it here."),
  p('Otherwise reply "send it" and the full breakdown\'s yours. Or grab a slot:'),
  p("&nbsp;"),
  p("{{senderName}}"),
].join("\n");

// Day 0 → wait 3 → Day 3 → wait 3 → Day 6. Emails 2 and 3 reuse subject 1 as "Re:" so they thread.
export const BLACKLIST_SEQUENCE = [
  { type: "email", order: 0, name: "Email 1 — Day 0", subject: SUBJECT, body: EMAIL_1 },
  { type: "wait", order: 1, name: "Wait 3 days", waitDays: 3 },
  { type: "email", order: 2, name: "Email 2 — Day 3", subject: `Re: ${SUBJECT}`, body: EMAIL_2 },
  { type: "wait", order: 3, name: "Wait 3 days", waitDays: 3 },
  { type: "email", order: 4, name: "Email 3 — Day 6", subject: `Re: ${SUBJECT}`, body: EMAIL_3 },
];

// Domains in the copy are DEFANGED (acme.com -> acme(.)com). A live link to a blacklisted domain in
// a cold email is exactly the kind of thing that gets the sending domain filtered, and mail clients
// would auto-link them; defanged they still read clearly to a human.
export const defang = (d) => String(d || "").replace(/\./g, "(.)");

// A human company name for the copy. The seed is a domain, so "ringcentral.com's 507 domains" reads
// like a machine wrote it — we want "RingCentral's". Prefer a real name we hold, else title-case the
// domain label rather than falling back to the bare domain.
export function displayCompany(target, person) {
  const real = target.companyName || person?.company;
  if (real) return real;
  const label = String(target.seed || "").split(".")[0].replace(/[-_]+/g, " ").trim();
  return label ? label.replace(/\b\w/g, (c) => c.toUpperCase()) : target.seed;
}

// Build the SendKit lead payload for one person at one prospect company. Standard fields are mapped
// by SendKit; everything else lands as a custom field and is addressable as {{key}} in the copy.
export function leadPayload(person, target) {
  const bl = target.blacklistedDomains || [];
  const top = bl.slice(0, 4).map((d) => defang(d.domain));
  return {
    email: person.email,
    firstName: person.first_name || (person.name || "").split(" ")[0] || "",
    lastName: person.last_name || (person.name || "").split(" ").slice(1).join(" ") || "",
    companyName: displayCompany(target, person),
    jobTitle: person.job_title || "",
    linkedinUrl: person.linkedin_url || "",
    // custom fields used by the copy
    secondaryDomainCount: String(target.redirectCount ?? bl.length),
    blacklistedDomainCount: String(target.blacklistedCount ?? bl.length),
    domain1: top[0] || "", domain2: top[1] || "", domain3: top[2] || "", domain4: top[3] || "",
    // full list (max 10) for the report / manual use — defanged too
    blacklistedDomains: bl.slice(0, 10).map((d) => defang(d.domain)).join(", "),
    seedDomain: target.seed,
    senderName: SENDER_NAME,
    tags: ["gtm-auto", "blacklist-campaign"],
  };
}
