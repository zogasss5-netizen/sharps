import type { Outcome } from "../model/poisson.js";

export type Side = "home" | "draw" | "away";
export const SIDES: Side[] = ["home", "draw", "away"];
export type Market = "1X2" | "AH" | "OU";

/** Asian-handicap quote (home perspective): P(home covers `line`). */
export interface AhQuote { line: number; coverModel: number; coverMarket: number; oddsHome: number; oddsAway: number; }
/** Over/Under quote: P(total over `line`). */
export interface OuQuote { line: number; overModel: number; overMarket: number; oddsOver: number; oddsUnder: number; }

/** One in-play observation across all three markets. */
export interface MarketSnapshot {
  minute: number;
  score: [number, number];
  model: Outcome;       // our fair 1X2
  marketProb: Outcome;  // de-vigged market 1X2
  marketOdds: Outcome;  // offered 1X2 odds (incl. vig)
  ah: AhQuote;
  ou: OuQuote;
}

export interface Bet {
  market: Market;
  selection: string;    // 1X2: home|draw|away · AH: home|away · OU: over|under
  line?: number;        // AH/OU line
  stake: number;
  oddsDecimal: number;  // locked at entry
  minute: number;
}

export type Mem = Record<string, unknown>;

export interface Strategy {
  name: string;
  blurb: string;
  decide(s: MarketSnapshot, prev: MarketSnapshot | undefined, mem: Mem, bankroll: number): Bet | null;
}

/** Settle a bet against the final score. Returns net pnl and whether it won. */
export function settleBet(
  b: { market: Market; selection: string; line?: number; stake: number; oddsDecimal: number },
  h: number, a: number,
): { pnl: number; win: boolean; push: boolean } {
  const profit = () => b.stake * (b.oddsDecimal - 1);
  if (b.market === "1X2") {
    const out = h > a ? "home" : h < a ? "away" : "draw";
    return b.selection === out ? { pnl: profit(), win: true, push: false } : { pnl: -b.stake, win: false, push: false };
  }
  if (b.market === "AH") {
    const m = (h - a) + (b.line ?? 0); // home perspective
    if (Math.abs(m) < 1e-9) return { pnl: 0, win: false, push: true };
    const homeCovers = m > 0;
    const won = b.selection === "home" ? homeCovers : !homeCovers;
    return won ? { pnl: profit(), win: true, push: false } : { pnl: -b.stake, win: false, push: false };
  }
  // OU
  const t = h + a, line = b.line ?? 0;
  if (Math.abs(t - line) < 1e-9) return { pnl: 0, win: false, push: true };
  const over = t > line;
  const won = b.selection === "over" ? over : !over;
  return won ? { pnl: profit(), win: true, push: false } : { pnl: -b.stake, win: false, push: false };
}
