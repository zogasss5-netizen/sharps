import { jointFit, fairPrices, type Markets } from "../model/crossmarket.js";
import { SIDES, type Bet, type MarketSnapshot, type Mem, type Side, type Strategy } from "./types.js";

function kelly(prob: number, odds: number, bankroll: number, frac = 0.25, cap = 0.05): number {
  const b = odds - 1; if (b <= 0) return 0;
  const f = (b * prob - (1 - prob)) / b;
  return f <= 0 ? 0 : Math.max(0, Math.min(f * frac, cap)) * bankroll;
}
const bestX2Edge = (s: MarketSnapshot): { side: Side; edge: number } => {
  let best = { side: "home" as Side, edge: -Infinity };
  for (const side of SIDES) { const edge = s.model[side] - s.marketProb[side]; if (edge > best.edge) best = { side, edge }; }
  return best;
};

/** 1. In-Play Value — back a 1X2 outcome our model prices above the market. Bounded + Kelly. */
const inplayValue: Strategy = {
  name: "inplay-value",
  blurb: "Backs the 1X2 outcome our model prices 4–20% above the market (the in-play lag edge). Quarter-Kelly, odds 1.2–8.",
  decide(s, _p, mem, bank) {
    if (mem.done) return null;
    const { side, edge } = bestX2Edge(s);
    const odds = s.marketOdds[side];
    if (edge < 0.04 || edge > 0.20 || odds < 1.2 || odds > 8) return null; // cap edge: >20% = artifact
    const stake = kelly(s.model[side], odds, bank);
    if (stake <= 0) return null;
    mem.done = true;
    return { market: "1X2", selection: side, stake, oddsDecimal: odds, minute: s.minute };
  },
};

/** 2. Steam (confirmed) — follow a sharp line move ONLY when our model agrees with it. */
const steam: Strategy = {
  name: "steam",
  blurb: "Follows a ≥3% market move toward a side, but only when our model also rates that side above the market.",
  decide(s, prev, mem, bank) {
    if (mem.done || !prev) return null;
    let best = { side: "home" as Side, move: 0 };
    for (const side of SIDES) { const mv = s.marketProb[side] - prev.marketProb[side]; if (mv > best.move) best = { side, move: mv }; }
    if (best.move < 0.03) return null;
    if (s.model[best.side] - s.marketProb[best.side] <= 0) return null; // model must confirm
    mem.done = true;
    return { market: "1X2", selection: best.side, stake: 0.02 * bank, oddsDecimal: s.marketOdds[best.side], minute: s.minute };
  },
};

/** 3. Cross-Market — fit one λ jointly to 1X2+AH+OU, back the most underpriced selection across markets. */
const crossArb: Strategy = {
  name: "cross-arb",
  blurb: "Triangulates 1X2 + Asian Handicap + Over/Under; backs whichever market is most underpriced vs the joint fair fit (2–15%).",
  decide(s, _p, mem, bank) {
    if (mem.done) return null;
    const m: Markets = {
      period: "sim", x2: s.marketProb,
      ah: { line: s.ah.line, p1: s.ah.coverMarket, oddsHome: s.ah.oddsHome, oddsAway: s.ah.oddsAway },
      ou: { line: s.ou.line, over: s.ou.overMarket, oddsOver: s.ou.oddsOver, oddsUnder: s.ou.oddsUnder },
    };
    const fit = jointFit(m);
    const f = fairPrices(fit.lambdaHome, fit.lambdaAway, s.ah.line, s.ou.line);
    type C = { market: Bet["market"]; selection: string; line?: number; odds: number; fair: number; mp: number };
    const cands: C[] = [
      { market: "1X2", selection: "home", odds: s.marketOdds.home, fair: f.x2.home, mp: s.marketProb.home },
      { market: "1X2", selection: "draw", odds: s.marketOdds.draw, fair: f.x2.draw, mp: s.marketProb.draw },
      { market: "1X2", selection: "away", odds: s.marketOdds.away, fair: f.x2.away, mp: s.marketProb.away },
      { market: "AH", selection: "home", line: s.ah.line, odds: s.ah.oddsHome, fair: f.ahCover, mp: s.ah.coverMarket },
      { market: "AH", selection: "away", line: s.ah.line, odds: s.ah.oddsAway, fair: 1 - f.ahCover, mp: 1 - s.ah.coverMarket },
      { market: "OU", selection: "over", line: s.ou.line, odds: s.ou.oddsOver, fair: f.over, mp: s.ou.overMarket },
      { market: "OU", selection: "under", line: s.ou.line, odds: s.ou.oddsUnder, fair: 1 - f.over, mp: 1 - s.ou.overMarket },
    ];
    const best = cands.reduce((x, y) => (y.fair - y.mp > x.fair - x.mp ? y : x));
    const value = best.fair - best.mp;
    if (value < 0.02 || value > 0.15 || best.odds < 1.2 || best.odds > 6) return null; // cap value: >15% = artifact
    const stake = kelly(best.fair, best.odds, bank);
    if (stake <= 0) return null;
    mem.done = true;
    return { market: best.market, selection: best.selection, line: best.line, stake, oddsDecimal: best.odds, minute: s.minute };
  },
};

/** 4. Market-Maker — small, frequent stakes whenever a 1X2 side is mispriced beyond the vig. */
const marketMaker: Strategy = {
  name: "market-maker",
  blurb: "Liquidity-style: small flat stakes on any 1X2 side priced ≥2% below fair, throttled to every 5 minutes.",
  decide(s, _p, mem, bank) {
    const last = (mem.lastMinute as number) ?? -10;
    if (s.minute - last < 5) return null;
    const { side, edge } = bestX2Edge(s);
    if (edge < 0.02) return null;
    mem.lastMinute = s.minute;
    return { market: "1X2", selection: side, stake: 0.01 * bank, oddsDecimal: s.marketOdds[side], minute: s.minute };
  },
};

/** 5. Favorite — control baseline: back the pre-match favorite, flat stake. */
const favorite: Strategy = {
  name: "favorite",
  blurb: "Baseline control. Backs the pre-match favorite at a flat 2% stake.",
  decide(s, _p, mem, bank) {
    if (mem.done || s.minute > 1) return null;
    const side = SIDES.reduce((a, b) => (s.marketProb[b] > s.marketProb[a] ? b : a), "home" as Side);
    mem.done = true;
    return { market: "1X2", selection: side, stake: 0.02 * bank, oddsDecimal: s.marketOdds[side], minute: s.minute };
  },
};

export const STRATEGIES: Strategy[] = [crossArb, inplayValue, steam, favorite];
