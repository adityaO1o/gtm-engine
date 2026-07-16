"use client";
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { num } from "@/lib/format";
import { j } from "@/lib/api";
import { funnel } from "@/lib/charts";
import { Donut, Area } from "./charts";
import { useDash } from "@/lib/ctx";

const Hero = ({ k, v, sub, cls }) => (
  <div className={`hero ${cls || ""}`}>
    <div className="hk">{k}</div>
    <div className="hv">{typeof v === "number" ? num(v) : v}</div>
    <div className="hs">{sub}</div>
  </div>
);
const Tile = ({ icon, k, v, cls }) => (
  <div className={`tile ${cls || ""}`}>
    <span className="tk"><Icon name={icon} />{k}</span>
    <span className="tv">{num(v)}</span>
  </div>
);
// Static, self-contained SVG/markup from the proven chart builders.
const Raw = ({ html, ...p }) => <div {...p} dangerouslySetInnerHTML={{ __html: html }} />;

function ApiUsagePanel({ s }) {
  const rv = s.resolver || {}, m = s.meter || {}, bal = s.apiBalance || {};
  const freshEng = m.rapid_engagers || 0;
  const eff = (b) => (b ? Math.max(0, Math.min(b.creditsRemaining ?? Infinity, b.requestsRemaining ?? Infinity)) : null);
  const fLeft = eff(bal.fresh), wLeft = eff(bal.webscrape), pLeft = eff(bal.pnd);
  const fLim = bal.fresh?.creditsLimit || 500, wLim = bal.webscrape?.creditsLimit || 500, pLim = bal.pnd?.creditsLimit || 10000;
  const Row = ({ name, val, note, warn }) => (
    <div className="urow">
      <span className="un">{name}</span>
      <span className={`uv ${warn ? "warn" : ""}`} dangerouslySetInnerHTML={{ __html: val }} />
      <span className="uc">{note}</span>
    </div>
  );
  return (
    <div className="chartbox" style={{ marginTop: "var(--s3)" }}>
      <h4><Icon name="radio" /> API consumption <span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>· real balance</span></h4>
      <div className="utable">
        <Row name="🟣 PND · scrape + enrich" warn={bal.pnd && pLeft <= 0}
          val={bal.pnd ? `<b>${num(pLeft)}</b> left / ${num(pLim)}` : `<b>${num(m.pnd_scrape_pages || 0)}</b> pages`}
          note={`${num(m.pnd_scrape_pages || 0)} scrape · ${num(m.pnd_profile_calls || 0)} profile · ${num(m.pnd_company_calls || 0)} company · ${num(m.pnd_cache_hits || 0)} cache-saved${bal.pnd && pLeft <= 0 ? " · OUT" : ""}`} />
        <Row name="💡 Domain source" val={`free <b>${num(m.domain_free || 0)}</b> · paid ${num(m.domain_paid || 0)}`}
          note="free tiers vs PND credits — higher free = cheaper" />
        <Row name="🟢 RapidAPI · Fresh (scrape)" warn={bal.fresh && fLeft <= 0}
          val={bal.fresh ? `<b>${num(fLeft)}</b> left / ${num(fLim)}` : `<b>${num(m.rapid_pages || 0)}</b> pages`}
          note={bal.fresh ? `${num(fLim - fLeft)} credits used · ${num(freshEng)} engagers scraped${fLeft <= 0 ? " · OUT" : ""}` : `${num(freshEng)} engagers`} />
        <Row name="🔵 RapidAPI · Web-scrape (profile)" warn={bal.webscrape && wLeft <= 0}
          val={bal.webscrape ? `<b>${num(wLeft)}</b> left / ${num(wLim)}` : `<b>${num(m.webscrape_calls || 0)}</b> calls`}
          note={bal.webscrape ? `${num(wLim - wLeft)} credits used · company lookups${wLeft <= 0 ? " · OUT" : ""}` : "company lookups"} />
        <Row name="🔎 Resolver" val={`SEO <b>${num(m.resolver_seo || 0)}</b> · Serper ${num(m.resolver_serper || 0)} · Proxy ${num(m.resolver_proxy || 0)}`}
          note={`URN→URL · ${num(m.resolver_miss || 0)} missed · ${num(rv.serperKeysLive || 0)}/${num(rv.serperKeysTotal || 0)} serper keys`} />
        <Row name="✉️ Prospeo" val={`<b>${num(m.prospeo_finds || 0)}</b>/${num(m.prospeo_calls || 0)} finds`} note="email finder" />
        <Row name="🛡️ Clearbit" val={`<b>${num(m.clearbit_calls || 0)}</b> lookups`} note={`name→domain · ${num(m.clearbit_rejects || 0)} wrong-domain blocked`} />
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
        Fresh &amp; Web-scrape “left” is the plans’ REAL remaining from RapidAPI rate-limit headers (blocks on whichever of credits/requests hits 0). Resolver/Prospeo/Clearbit are counters tracked since the meter was added.
      </div>
    </div>
  );
}

export default function Overview() {
  const { stats: s } = useDash();               // reuse the topbar's stats — no duplicate /api/stats
  const [a, setA] = useState(null);
  useEffect(() => { j("/api/analytics").then(setA).catch(() => setA({ err: true })); }, []);
  if (!a || s.total == null) return <div className="loading"><span className="spin" />Loading overview…</div>;
  if (a.err) return <div className="muted" style={{ padding: 40 }}>Couldn’t load analytics.</div>;
  const rate = s.total ? Math.round((s.verified / s.total) * 100) : 0;
  return (
    <>
      <div className="grid g-hero">
        <Hero k="Total leads" v={s.total} sub="scraped & enriched" />
        <Hero k="Verified emails" v={s.verified} sub="ready to send" cls="pri" />
        <Hero k="Hit rate" v={`${rate}%`} sub="of leads have an email" cls={rate >= 50 ? "good" : ""} />
        <Hero k="Recovered" v={s.recovered} sub="rescued by retry" cls="good" />
      </div>

      <div className="grid g-tiles">
        <Tile icon="bolt" k="Hot" v={s.hot} cls="hot" />
        <Tile icon="warn" k="Warm" v={s.warm} cls="warm" />
        <Tile icon="users" k="Cold" v={s.cold} cls="cold" />
        <Tile icon="inbox" k="No-email" v={s.noEmail} />
        <Tile icon="warn" k="Review" v={s.review} cls="warm" />
        <Tile icon="flag" k="Competitors" v={s.competitor} />
        <Tile icon="x" k="DNC" v={s.dnc} cls="hot" />
      </div>

      <div className="charts" style={{ marginTop: "var(--s4)" }}>
        <div className="chartbox">
          <h4>Status split</h4>
          <Donut segs={[{ value: a.status.hot, color: "#DC2B2B", label: "Hot" }, { value: a.status.warm, color: "#B26B00", label: "Warm" }, { value: a.status.cold, color: "#2E90D9", label: "Cold" }]} />
          <div className="legend">
            <span><i style={{ background: "#DC2B2B" }} />Hot {num(a.status.hot)}</span>
            <span><i style={{ background: "#B26B00" }} />Warm {num(a.status.warm)}</span>
            <span><i style={{ background: "#2E90D9" }} />Cold {num(a.status.cold)}</span>
          </div>
        </div>
        <div className="chartbox">
          <h4>Leads over time</h4>
          <Area series={a.series} />
          <div className="legend">
            <span><i style={{ background: "#6C47FF" }} />Total</span>
            <span><i style={{ background: "#0C8A45" }} />Verified</span>
          </div>
        </div>
      </div>

      <div className="chartbox" style={{ marginTop: "var(--s3)" }}>
        <h4>Email funnel</h4>
        <Raw html={funnel(a.funnel)} />
        <div className="legend">
          <span>No-email {num(a.funnel.noEmail)}</span>
          <span><b style={{ color: "var(--good)" }}>Recovered {num(s.recovered)}</b></span>
          <span>Review {num(a.funnel.review)}</span>
          <span>Competitors {num(a.funnel.competitor)}</span>
          <span>Unverified {num(a.funnel.unverified)}</span>
        </div>
      </div>

      <ApiUsagePanel s={s} />
    </>
  );
}
