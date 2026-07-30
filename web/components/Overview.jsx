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
    </>
  );
}
