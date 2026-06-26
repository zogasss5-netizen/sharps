// Cross-market triangulation — the differentiator.
//
// TxLINE streams 1X2, Asian Handicap, and Over/Under for every match. Each is an
// independent view of the same two Poisson goal rates. We fit ONE (lambdaHome, lambdaAway)
// jointly to all three, then the per-market residual (market price - joint-fair price) tells
// us which market is offside. Trade the offside one. This is model-light, uses the full
// breadth of the feed, and is far beyond a single-market "edge" bot.

import { poissonPmf, type Outcome } from "./poisson.js";

const MAXG = 12;

/** Joint scoreline distribution for (lambdaHome, lambdaAway). */
function scoreGrid(lh: number, la: number): number[][] {
  const ph: number[] = [], pa: number[] = [];
  for (let k = 0; k <= MAXG; k++) { ph[k] = poissonPmf(k, lh); pa[k] = poissonPmf(k, la); }
  const g: number[][] = [];
  let tot = 0;
  for (let h = 0; h <= MAXG; h++) { g[h] = []; for (let a = 0; a <= MAXG; a++) { const p = ph[h]! * pa[a]!; g[h]![a] = p; tot += p; } }
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) g[h]![a]! /= tot;
  return g;
}

export function gridX2(g: number[][]): Outcome {
  let home = 0, draw = 0, away = 0;
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
    const p = g[h]![a]!; if (h > a) home += p; else if (h === a) draw += p; else away += p;
  }
  return { home, draw, away };
}

/** De-margined 2-way: P(home margin beats Asian line) excluding pushes. line<0 = home favored. */
export function gridAhCover(g: number[][], line: number): number {
  let over = 0, under = 0;
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
    const m = h - a + line; const p = g[h]![a]!;
    if (m > 1e-9) over += p; else if (m < -1e-9) under += p; // m==0 push -> dropped
  }
  return over / (over + under || 1);
}

/** De-margined 2-way: P(total goals over the line) excluding pushes. */
export function gridOver(g: number[][], line: number): number {
  let over = 0, under = 0;
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
    const t = h + a - line; const p = g[h]![a]!;
    if (t > 1e-9) over += p; else if (t < -1e-9) under += p;
  }
  return over / (over + under || 1);
}

/** Joint-fair prices at given lines, for comparing against the market. */
export function fairPrices(lh: number, la: number, ahLine: number, ouLine: number) {
  const g = scoreGrid(lh, la);
  return { x2: gridX2(g), ahCover: gridAhCover(g, ahLine), over: gridOver(g, ouLine) };
}

export interface Markets {
  period: string;
  x2?: Outcome;                       // de-vigged home/draw/away
  x2odds?: { home: number; draw: number; away: number }; // offered decimal odds
  ah?: { line: number; p1: number; oddsHome: number; oddsAway: number };  // home perspective
  ou?: { line: number; over: number; oddsOver: number; oddsUnder: number };
}

/** Fit one (lambdaHome, lambdaAway) jointly to whatever markets are present. */
export function jointFit(m: Markets): { lambdaHome: number; lambdaAway: number; err: number } {
  const err = (lh: number, la: number) => {
    const g = scoreGrid(lh, la);
    let e = 0;
    if (m.x2) { const x = gridX2(g); e += (x.home - m.x2.home) ** 2 + (x.draw - m.x2.draw) ** 2 + (x.away - m.x2.away) ** 2; }
    if (m.ah) e += (gridAhCover(g, m.ah.line) - m.ah.p1) ** 2;
    if (m.ou) e += (gridOver(g, m.ou.line) - m.ou.over) ** 2;
    return e;
  };
  let best = { lambdaHome: 1.3, lambdaAway: 1.1, err: Infinity };
  for (let lh = 0.1; lh <= 3.6; lh += 0.1) for (let la = 0.1; la <= 3.6; la += 0.1) {
    const e = err(lh, la); if (e < best.err) best = { lambdaHome: lh, lambdaAway: la, err: e };
  }
  const { lambdaHome: ch, lambdaAway: ca } = best;
  for (let lh = ch - 0.1; lh <= ch + 0.1; lh += 0.02) for (let la = ca - 0.1; la <= ca + 0.1; la += 0.02) {
    if (lh <= 0 || la <= 0) continue; const e = err(lh, la); if (e < best.err) best = { lambdaHome: lh, lambdaAway: la, err: e };
  }
  return best;
}

const devig2 = (d1: number, d2: number) => { const a = 1 / d1, b = 1 / d2; return a / (a + b); };
const parseLine = (mp: string | null) => { const m = /line=(-?\d+(?:\.\d+)?)/.exec(mp ?? ""); return m ? parseFloat(m[1]!) : NaN; };

/** Parse raw demargined odds rows into joint-fittable markets, on the most complete period. */
export function parseMarkets(rows: any[], p1IsHome: boolean): Markets | null {
  const dem = rows.filter((r) => typeof r.Bookmaker === "string" && r.Bookmaker.includes("Demargined"));
  const periods = new Map<string, any[]>();
  for (const r of dem) { const k = r.MarketPeriod ?? "FT"; (periods.get(k) ?? periods.set(k, []).get(k)!).push(r); }

  const score = (rs: any[]) => new Set(rs.map((r) => r.SuperOddsType)).size;
  const ranked = [...periods.entries()].sort((a, b) => {
    const s = score(b[1]) - score(a[1]); if (s) return s;
    return (b[0] === "FT" ? 1 : 0) - (a[0] === "FT" ? 1 : 0);
  });
  if (!ranked.length) return null;
  const [period, rs] = ranked[0]!;
  const latest = (t: string) => rs.filter((r) => r.SuperOddsType === t).sort((a, b) => b.Ts - a.Ts);

  const m: Markets = { period };

  const x2row = latest("1X2_PARTICIPANT_RESULT")[0];
  if (x2row?.Prices?.length >= 3) {
    const d = x2row.Prices.map((p: number) => p / 1000);
    const inv = d.map((x: number) => 1 / x); const s = inv[0] + inv[1] + inv[2];
    const part1 = inv[0] / s, draw = inv[1] / s, part2 = inv[2] / s;
    m.x2 = p1IsHome ? { home: part1, draw, away: part2 } : { home: part2, draw, away: part1 };
    m.x2odds = p1IsHome ? { home: d[0], draw: d[1], away: d[2] } : { home: d[2], draw: d[1], away: d[0] };
  }

  // Asian handicap — pick the main line (de-vig closest to 50/50), map to home perspective.
  const ahRows = latest("ASIANHANDICAP_PARTICIPANT_GOALS").map((r) => {
    const line = parseLine(r.MarketParameters); const d = r.Prices.map((p: number) => p / 1000);
    const p1 = devig2(d[0], d[1]); // part1 covers
    return p1IsHome
      ? { line, p1, oddsHome: d[0], oddsAway: d[1] }
      : { line: -line, p1: 1 - p1, oddsHome: d[1], oddsAway: d[0] };
  }).filter((x) => isFinite(x.line));
  if (ahRows.length) m.ah = ahRows.sort((a, b) => Math.abs(a.p1 - 0.5) - Math.abs(b.p1 - 0.5))[0];

  // Over/Under — main total (de-vig closest to 50/50).
  const ouRows = latest("OVERUNDER_PARTICIPANT_GOALS").map((r) => {
    const line = parseLine(r.MarketParameters); const d = r.Prices.map((p: number) => p / 1000);
    return { line, over: devig2(d[0], d[1]), oddsOver: d[0], oddsUnder: d[1] };
  }).filter((x) => isFinite(x.line));
  if (ouRows.length) m.ou = ouRows.sort((a, b) => Math.abs(a.over - 0.5) - Math.abs(b.over - 0.5))[0];

  return m.x2 || m.ah || m.ou ? m : null;
}

export interface CrossValue {
  market: "1X2" | "AH" | "OU"; selection: string; line?: number; odds: number; fair: number; mp: number; value: number;
}
/** Best underpriced selection across all markets vs the joint fair fit. */
export function bestCrossValue(m: Markets, lh: number, la: number): CrossValue | null {
  const f = fairPrices(lh, la, m.ah?.line ?? 0, m.ou?.line ?? 0);
  const c: Omit<CrossValue, "value">[] = [];
  if (m.x2 && m.x2odds) for (const s of ["home", "draw", "away"] as const) c.push({ market: "1X2", selection: s, odds: m.x2odds[s], fair: f.x2[s], mp: m.x2[s] });
  if (m.ah) { c.push({ market: "AH", selection: "home", line: m.ah.line, odds: m.ah.oddsHome, fair: f.ahCover, mp: m.ah.p1 }); c.push({ market: "AH", selection: "away", line: m.ah.line, odds: m.ah.oddsAway, fair: 1 - f.ahCover, mp: 1 - m.ah.p1 }); }
  if (m.ou) { c.push({ market: "OU", selection: "over", line: m.ou.line, odds: m.ou.oddsOver, fair: f.over, mp: m.ou.over }); c.push({ market: "OU", selection: "under", line: m.ou.line, odds: m.ou.oddsUnder, fair: 1 - f.over, mp: 1 - m.ou.over }); }
  if (!c.length) return null;
  const best = c.reduce((x, y) => (y.fair - y.mp > x.fair - x.mp ? y : x));
  return { ...best, value: best.fair - best.mp };
}

export interface Dislocation {
  market: "1X2" | "AH" | "OU";
  detail: string;
  marketPrice: number; // what the market implies
  fairPrice: number;   // joint-fair implied
  residualBp: number;  // (market - fair) * 10000
}

/** Per-market residuals vs the joint fair fit. Largest |residual| = most offside. */
export function dislocations(m: Markets, lh: number, la: number): Dislocation[] {
  const g = scoreGrid(lh, la);
  const out: Dislocation[] = [];
  if (m.x2) {
    const x = gridX2(g);
    for (const k of ["home", "draw", "away"] as const)
      out.push({ market: "1X2", detail: k, marketPrice: m.x2[k], fairPrice: x[k], residualBp: Math.round((m.x2[k] - x[k]) * 10000) });
  }
  if (m.ah) {
    const fair = gridAhCover(g, m.ah.line);
    out.push({ market: "AH", detail: `cover ${m.ah.line >= 0 ? "+" : ""}${m.ah.line}`, marketPrice: m.ah.p1, fairPrice: fair, residualBp: Math.round((m.ah.p1 - fair) * 10000) });
  }
  if (m.ou) {
    const fair = gridOver(g, m.ou.line);
    out.push({ market: "OU", detail: `over ${m.ou.line}`, marketPrice: m.ou.over, fairPrice: fair, residualBp: Math.round((m.ou.over - fair) * 10000) });
  }
  return out.sort((a, b) => Math.abs(b.residualBp) - Math.abs(a.residualBp));
}
