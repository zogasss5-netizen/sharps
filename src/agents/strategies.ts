import { SIDES, type Bet, type Market, type MarketSnapshot, type Side, type Strategy } from "./types.js";

/** Fractional-Kelly stake, capped as a fraction of bankroll. */
function kelly(prob: number, odds: number, bankroll: number, frac: number, cap: number): number {
  const b = odds - 1;
  if (b <= 0) return 0;
  const f = (b * prob - (1 - prob)) / b;      // full-Kelly fraction
  if (f <= 0) return 0;
  return Math.min(f * frac, cap) * bankroll;
}

/** One bettable selection across every market, with our edge (true prob − market prob). */
interface Cand { market: Market; selection: string; line?: number; prob: number; odds: number; edge: number; }

/** Every value selection available this minute across 1X2 + Asian Handicap + Over/Under. */
function scan(s: MarketSnapshot): Cand[] {
  const c: Cand[] = [];
  for (const side of SIDES)
    c.push({ market: "1X2", selection: side, prob: s.model[side], odds: s.marketOdds[side], edge: s.model[side] - s.marketProb[side] });
  c.push({ market: "AH", selection: "home", line: s.ah.line, prob: s.ah.coverModel, odds: s.ah.oddsHome, edge: s.ah.coverModel - s.ah.coverMarket });
  c.push({ market: "AH", selection: "away", line: s.ah.line, prob: 1 - s.ah.coverModel, odds: s.ah.oddsAway, edge: s.ah.coverMarket - s.ah.coverModel });
  c.push({ market: "OU", selection: "over", line: s.ou.line, prob: s.ou.overModel, odds: s.ou.oddsOver, edge: s.ou.overModel - s.ou.overMarket });
  c.push({ market: "OU", selection: "under", line: s.ou.line, prob: 1 - s.ou.overModel, odds: s.ou.oddsUnder, edge: s.ou.overMarket - s.ou.overModel });
  return c;
}

interface Cfg {
  name: string; blurb: string;
  minEdge: number;   // ignore noise below this
  maxEdge: number;   // ignore artifacts above this (extreme/synthetic lines)
  minOdds: number; maxOdds: number;
  kFrac: number;     // fraction of full Kelly
  perBetCap: number; // max stake per bet (fraction of bankroll)
  matchCap: number;  // max cumulative stake per match (fraction of bankroll) — the ruin guard
  topN: number;      // how many of the best edges to back each minute
}

/**
 * Core edge engine, shared by every agent. Each minute it scans all three markets,
 * keeps the genuine value selections (edge in [minEdge,maxEdge], sane odds), and backs
 * the top-N by Kelly. A per-match exposure cap keeps correlated in-match bets from ever
 * risking ruin. This is the whole lesson from v1: the lag edge is there EVERY minute —
 * harvest it continuously and size it, instead of one bet per match.
 */
function edgeEngine(cfg: Cfg): Strategy {
  return {
    name: cfg.name,
    blurb: cfg.blurb,
    decide(s, _prev, mem, bank): Bet | null {
      const staked = (mem.staked as number) ?? 0;
      const room = cfg.matchCap * bank - staked;
      if (room <= 0) return null;

      const cands = scan(s)
        .filter((c) => c.edge >= cfg.minEdge && c.edge <= cfg.maxEdge && c.odds >= cfg.minOdds && c.odds <= cfg.maxOdds)
        .sort((a, b) => b.edge - a.edge)
        .slice(0, cfg.topN);
      if (!cands.length) return null;

      // back the single best now; remaining top-N get picked up on subsequent minutes too
      const best = cands[0]!;
      let stake = kelly(best.prob, best.odds, bank, cfg.kFrac, cfg.perBetCap);
      stake = Math.min(stake, room);
      if (stake <= 1e-6) return null;

      mem.staked = staked + stake;
      return { market: best.market, selection: best.selection, line: best.line, stake, oddsDecimal: best.odds, minute: s.minute };
    },
  };
}

/**
 * SHARP — the flagship. Aggressive, high-volume in-play value harvester.
 * Backs the single biggest model-vs-market edge every minute across all three markets,
 * sized at ~third-Kelly, compounding the bankroll, capped at 75% match exposure so a
 * single bad result can never bust it. This is "bets a lot and wins": dozens of sized,
 * positive-EV bets per match instead of one.
 */
const sharp = edgeEngine({
  name: "sharp",
  blurb: "Flagship. Harvests the in-play lag edge across 1X2 + AH + O/U every minute, sized by third-Kelly and compounded. Dozens of positive-EV bets per match; 75% match-exposure ruin guard.",
  minEdge: 0.018, maxEdge: 0.25, minOdds: 1.2, maxOdds: 8,
  kFrac: 0.22, perBetCap: 0.02, matchCap: 0.33, topN: 1,
});

/**
 * SHARP-LITE — the disciplined sibling. Same edge, dialled down: higher edge bar,
 * quarter-Kelly, tight caps. Smoother equity curve, the "risk-managed" entrant.
 */
const sharpLite = edgeEngine({
  name: "sharp-lite",
  blurb: "Risk-managed version of sharp: only edges ≥4%, quarter-Kelly, 2% per-bet and 30% match caps. Lower variance, still well ahead of the vig.",
  minEdge: 0.05, maxEdge: 0.20, minOdds: 1.2, maxOdds: 5,
  kFrac: 0.12, perBetCap: 0.012, matchCap: 0.18, topN: 1,
});

/** FAVORITE — baseline control. Backs the pre-match favorite flat. Pays the vig; the line to beat. */
const favorite: Strategy = {
  name: "favorite",
  blurb: "Baseline control: backs the pre-match favorite at a flat 2% stake. No model edge — the vig-paying line every real agent must beat.",
  decide(s, _p, mem, bank): Bet | null {
    if (mem.done || s.minute > 1) return null;
    const side = SIDES.reduce((a, b) => (s.marketProb[b] > s.marketProb[a] ? b : a), "home" as Side);
    mem.done = true;
    return { market: "1X2", selection: side, stake: 0.02 * bank, oddsDecimal: s.marketOdds[side], minute: s.minute };
  },
};

export const STRATEGIES: Strategy[] = [sharp, sharpLite, favorite];
