import { inPlayProbs, type Outcome } from "../model/poisson.js";
import { parseMarkets, jointFit, dislocations, bestCrossValue, type Dislocation } from "../model/crossmarket.js";
import { normalizeFixture, normalizeOdds, normalizeScores, WORLD_CUP_COMPETITION_ID } from "../model/normalize.js";
import type { Market } from "./types.js";
import type { OddsLookup } from "./ledger.js";

/** Build a current-odds lookup from raw rows — feeds the ledger's CLV repricing. */
export function currentOddsLookup(rows: { fixture: any; odds: any[] }[]): OddsLookup {
  const map = new Map<string, number>();
  for (const { fixture, odds } of rows) {
    const f = normalizeFixture(fixture);
    const mk = normalizeOdds(odds, f.p1IsHome);
    if (mk) { map.set(`${f.fixtureId}|1X2|home`, mk.decimal.home); map.set(`${f.fixtureId}|1X2|draw`, mk.decimal.draw); map.set(`${f.fixtureId}|1X2|away`, mk.decimal.away); }
    const m = parseMarkets(odds, f.p1IsHome);
    if (m?.ah) { map.set(`${f.fixtureId}|AH|home`, m.ah.oddsHome); map.set(`${f.fixtureId}|AH|away`, m.ah.oddsAway); }
    if (m?.ou) { map.set(`${f.fixtureId}|OU|over`, m.ou.oddsOver); map.set(`${f.fixtureId}|OU|under`, m.ou.oddsUnder); }
  }
  // match by fixture+market+selection (current main line) — a live proxy for line movement
  return (fid, market, sel) => map.get(`${fid}|${market}|${sel}`);
}

export interface LiveFixture {
  label: string; fixtureId: number; period: string; minute: number; score: [number, number]; inRunning: boolean;
  startTime: number;               // scheduled kickoff (epoch ms)
  present: string;                 // which markets present, e.g. "1X2+AH+OU"
  jointLambda: [number, number];
  model: Outcome;                  // in-play 1X2 model
  marketX2?: Outcome;              // market 1X2
  cross: Dislocation[];            // per-market residuals vs joint fair
}

export interface Signal {
  ts: number; agent: string; fixture: string; fixtureId: number; market: string; side: string; detail: string; edgeBp: number;
  // book-able fields (for the live ledger)
  selection?: string; oddsDecimal?: number; line?: number; fairProb?: number; onchain?: string;
}

export interface LiveTick { fixtures: LiveFixture[]; signals: Signal[]; }

// Quality gates — keep the bots honest. A de-vigged market is efficient, so edges are
// small and rare; anything huge is a data artifact and gets rejected.
const FIT_OK = 3e-3;     // only trust the joint fair if the 3 markets fit this well
const ODDS_LO = 1.2, ODDS_HI = 6.0;
const CROSS_MIN = 0.02, CROSS_MAX = 0.15;  // cross-market value bounds (2%–15%)
const INPLAY_MIN = 0.03, INPLAY_MAX = 0.20; // in-play edge bounds (live only)
const STEAM_MIN = 0.025, STEAM_MAX = 0.25;  // sustained line-move bounds
const okOdds = (o: number) => o >= ODDS_LO && o <= ODDS_HI;

/** Build one live tick from raw API rows, using prev tick for steam detection. */
export function buildTick(
  rows: { fixture: any; odds: any[]; scores: any[] }[],
  prev: Map<number, LiveFixture> | undefined,
  now: number,
): LiveTick {
  const fixtures: LiveFixture[] = [];
  const signals: Signal[] = [];

  for (const { fixture, odds, scores } of rows) {
    if (fixture.CompetitionId !== WORLD_CUP_COMPETITION_ID) continue;
    const f = normalizeFixture(fixture);
    const m = parseMarkets(odds, f.p1IsHome);
    if (!m) continue;
    const market = normalizeOdds(odds, f.p1IsHome);
    const score = normalizeScores(scores, f.p1IsHome);
    const fit = jointFit(m);
    const cross = dislocations(m, fit.lambdaHome, fit.lambdaAway);

    // in-play model from joint lambdas (cross-market-informed pre-match rates)
    const model = inPlayProbs({
      minute: score?.minute ?? 0, homeGoals: score?.homeGoals ?? 0, awayGoals: score?.awayGoals ?? 0,
      preLambdaHome: fit.lambdaHome, preLambdaAway: fit.lambdaAway, redHome: score?.redHome, redAway: score?.redAway,
    });

    const lf: LiveFixture = {
      label: `${f.home} v ${f.away}`, fixtureId: f.fixtureId, period: m.period,
      minute: Math.round(score?.minute ?? 0), score: [score?.homeGoals ?? 0, score?.awayGoals ?? 0],
      inRunning: !!market?.inRunning, startTime: f.startTime,
      present: [m.x2 && "1X2", m.ah && "AH", m.ou && "OU"].filter(Boolean).join("+"),
      jointLambda: [+fit.lambdaHome.toFixed(2), +fit.lambdaAway.toFixed(2)],
      model, marketX2: market?.probs, cross,
    };
    fixtures.push(lf);

    // --- bots (book-able, gated) ---
    const trusted = fit.err < FIT_OK;            // do we trust the joint fair price?
    const hasAll3 = !!(m.x2 && m.ah && m.ou);
    const minute = lf.minute;

    // 1) cross-arb — cross-market triangulation. Needs all 3 markets + a clean fit.
    if (trusted && hasAll3) {
      const cv = bestCrossValue(m, fit.lambdaHome, fit.lambdaAway);
      if (cv && cv.value >= CROSS_MIN && cv.value <= CROSS_MAX && okOdds(cv.odds))
        signals.push({ ts: now, agent: "cross-arb", fixture: lf.label, fixtureId: f.fixtureId, market: cv.market, side: cv.selection, detail: `fair ${(cv.fair * 100).toFixed(1)}% vs mkt ${(cv.mp * 100).toFixed(1)}% @${cv.odds.toFixed(2)}`, edgeBp: Math.round(cv.value * 10000), selection: cv.selection, oddsDecimal: cv.odds, line: cv.line, fairProb: cv.fair });
    }

    // 2) inplay-value — LIVE only: after goals the market lags the new fair. Bounded.
    if (market && trusted && minute > 0) {
      let best: { side: keyof Outcome; e: number } = { side: "home", e: -1e9 };
      for (const s of ["home", "draw", "away"] as const) { const e = model[s] - market.probs[s]; if (e > best.e) best = { side: s, e }; }
      if (best.e >= INPLAY_MIN && best.e <= INPLAY_MAX && okOdds(market.decimal[best.side]))
        signals.push({ ts: now, agent: "inplay-value", fixture: lf.label, fixtureId: f.fixtureId, market: "1X2", side: best.side, detail: `model ${(model[best.side] * 100).toFixed(1)}% vs ${(market.probs[best.side] * 100).toFixed(1)}% @${minute}'`, edgeBp: Math.round(best.e * 10000), selection: best.side, oddsDecimal: market.decimal[best.side], fairProb: model[best.side] });
    }

    // 3) steam — a real line move since last tick, confirmed by our fair. Bounded.
    const p = prev?.get(f.fixtureId);
    if (market && p?.marketX2) {
      let best: { side: keyof Outcome; mv: number } = { side: "home", mv: 0 };
      for (const s of ["home", "draw", "away"] as const) { const mv = market.probs[s] - p.marketX2![s]; if (mv > best.mv) best = { side: s, mv }; }
      const confirmed = model[best.side] - market.probs[best.side] >= 0; // our fair agrees with the move
      if (best.mv >= STEAM_MIN && best.mv <= STEAM_MAX && confirmed && okOdds(market.decimal[best.side]))
        signals.push({ ts: now, agent: "steam", fixture: lf.label, fixtureId: f.fixtureId, market: "1X2", side: best.side, detail: `+${(best.mv * 100).toFixed(1)}% move, confirmed`, edgeBp: Math.round(best.mv * 10000), selection: best.side, oddsDecimal: market.decimal[best.side], fairProb: model[best.side] });
    }

    // 4) favorite — baseline control: back the pre-match favorite once, flat.
    if (market && minute <= 1) {
      const side = (["home", "draw", "away"] as const).reduce((a, b) => (market.probs[b] > market.probs[a] ? b : a), "home" as keyof Outcome);
      if (okOdds(market.decimal[side]))
        signals.push({ ts: now, agent: "favorite", fixture: lf.label, fixtureId: f.fixtureId, market: "1X2", side, detail: `favorite @${market.decimal[side].toFixed(2)}`, edgeBp: 0, selection: side, oddsDecimal: market.decimal[side], fairProb: market.probs[side] });
    }
  }
  return { fixtures, signals };
}
