// Adapter: transform our real tracker state into the schema the Trading Terminal design
// (Claude Design .dc.html) expects. Lets us deploy that exact design driven by live data.

const TEAMS: Record<string, [string, string]> = {
  France: ["FRA", "#2b6cff"], Norway: ["NOR", "#d4253a"], Brazil: ["BRA", "#ffd23f"], England: ["ENG", "#e8edf6"],
  Spain: ["ESP", "#f5384e"], Germany: ["GER", "#cfd6e2"], Portugal: ["POR", "#d4253a"], Netherlands: ["NED", "#ff8c2b"],
  Argentina: ["ARG", "#62d0ff"], Senegal: ["SEN", "#2fa84f"], Iraq: ["IRQ", "#cf3b3b"], Egypt: ["EGY", "#d33"],
  Iran: ["IRN", "#2fa84f"], Croatia: ["CRO", "#e23b3b"], Ghana: ["GHA", "#2fa84f"], Uruguay: ["URU", "#5fc8e8"],
  Japan: ["JPN", "#d64b8a"], Morocco: ["MAR", "#1f8a4c"], USA: ["USA", "#5fa8e8"], Belgium: ["BEL", "#e8b53b"],
  Colombia: ["COL", "#f5c542"], Algeria: ["ALG", "#2fa84f"], Austria: ["AUT", "#e8e8ef"], Jordan: ["JOR", "#cf3b3b"],
  Canada: ["CAN", "#e23b3b"], Panama: ["PAN", "#c33"], Turkey: ["TUR", "#e23b3b"], Paraguay: ["PAR", "#e23b3b"],
  Australia: ["AUS", "#ffd23f"], Vietnam: ["VIE", "#d4253a"], Myanmar: ["MYA", "#ffd23f"], Mexico: ["MEX", "#1f8a4c"],
  Italy: ["ITA", "#3b6bd6"], "Cape Verde": ["CPV", "#2b6cff"], "Saudi Arabia": ["KSA", "#2fa84f"],
  "New Zealand": ["NZL", "#cfd6e2"], "Congo DR": ["COD", "#5fa8e8"], Uzbekistan: ["UZB", "#5fc8e8"],
  "South Africa": ["RSA", "#2fa84f"], "Bosnia & Herzegovina": ["BIH", "#3b6bd6"],
};
function info(name: string) {
  const n = (name || "").trim();
  const t = TEAMS[n];
  if (t) return { name: n, abbr: t[0], color: t[1] };
  let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360;
  return { name: n, abbr: n.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "TBD", color: `hsl(${h} 64% 56%)` };
}
const split = (label: string) => { const p = (label || "").split(" v "); return { h: info(p[0] || "Home"), a: info(p[1] || "Away") }; };
const abbrLabel = (label: string) => { const { h, a } = split(label); return `${h.abbr} v ${a.abbr}`; };

const MKT: Record<string, string> = { OU: "Total", "1X2": "1X2", AH: "AH" };
function sel(b: any, hAbbr: string, aAbbr: string) {
  if (b.market === "OU") return b.selection === "over" ? "Over" : "Under";
  if (b.selection === "draw") return "Draw";
  return b.selection === "home" ? hAbbr : aAbbr;
}
function feedMarket(x: any) {
  if (x.market === "OU") return `${x.side === "over" ? "Over" : "Under"} ${x.line ?? ""}`.trim();
  if (x.market === "AH") return `AH ${x.line >= 0 ? "+" + x.line : x.line}`;
  return "1X2";
}
const KIND: Record<string, string> = { GOAL: "signal", KICKOFF: "signal", FT: "settle", SETTLED: "settle", ONCHAIN: "validate" };

export function adaptToTerminal(s: any) {
  const fx = (s.fixtures || []).map((f: any) => {
    const { h, a } = split(f.label);
    return {
      fixtureId: String(f.fixtureId), label: `${h.abbr} v ${a.abbr}`, minute: f.minute, score: f.score,
      inRunning: !!f.inRunning, startTime: f.startTime ?? null, present: !!f.market, home: h, away: a,
      model: f.model, market: f.market || [0.34, 0.33, 0.33],
      cross: (f.cross || []).map((c: any) => ({ market: c.market, detail: c.detail, bp: c.bp })),
      stats: f.stats || { home: { goals: 0, corners: 0, yellow: 0, red: 0 }, away: { goals: 0, corners: 0, yellow: 0, red: 0 } },
      events: f.events || [],
    };
  });
  const mapBet = (b: any) => { const { h, a } = split(b.label); return {
    agent: b.agent, fixtureId: b.fixtureId != null ? String(b.fixtureId) : undefined,
    label: `${h.abbr} v ${a.abbr}`, market: MKT[b.market] || b.market, selection: sel(b, h.abbr, a.abbr),
    line: b.line ?? 0, odds: b.odds, stake: b.stake, clvPct: b.clvPct ?? 0 }; };

  const L = s.ledger || {};
  return {
    generatedAtMs: s.generatedAtMs,
    live: {
      tick: s.live?.tick ?? 0,
      feed: (s.live?.feed || []).map((x: any) => ({
        agent: x.agent, fixture: abbrLabel(x.fixture), market: feedMarket(x),
        side: x.market === "OU" ? (x.side === "over" ? "Over" : "Under") : (() => { const { h, a } = split(x.fixture); return x.side === "home" ? h.abbr : x.side === "away" ? a.abbr : "Draw"; })(),
        edgeBp: x.edgeBp, onchain: !!x.onchain,
      })),
    },
    ledger: {
      openCount: L.openCount ?? 0,
      clv: (L.clv || []).map((c: any) => ({ agent: c.agent, avgClv: c.avgClv, beatRate: +(c.beatRate / 100).toFixed(2), n: c.n })),
      leaderboard: (L.leaderboard || []).map((r: any) => ({ agent: r.agent, pnl: r.pnl, roi: +(r.roi / 100).toFixed(3), settled: r.settled })),
      open: (L.open || []).map(mapBet),
      allOpen: (L.allOpen || []).map(mapBet),
    },
    fixtures: fx,
    backlog: (s.backlog || []).map((e: any) => ({ t: e.t, kind: KIND[e.kind] || "signal", label: e.label, detail: e.detail })),
    onchain: {
      program: s.onchain?.program, intentTx: s.onchain?.intentTx, validateTx: s.onchain?.validateTx,
      liveIntents: (s.onchain?.liveIntents || []).map((x: any) => ({ tx: x.tx, fixture: abbrLabel(x.fixture), market: x.market, side: x.side })),
    },
    leaderboard: (s.leaderboard || []).map((r: any) => ({ name: r.name, roi: +(r.roi / 100).toFixed(3), pnl: r.pnl, hitRate: +((r.hitRate || 0) / 100).toFixed(3), equity: r.equity || [] })),
  };
}
