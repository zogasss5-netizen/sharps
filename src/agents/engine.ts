import { simulateMatch } from "./simulate.js";
import { STRATEGIES } from "./strategies.js";
import { settleBet, type Bet, type MarketSnapshot, type Mem } from "./types.js";

export interface MatchSpec { label: string; lambdaHome: number; lambdaAway: number; }

export interface StratResult {
  name: string;
  blurb: string;
  bankroll: number;
  pnl: number;
  roi: number;        // pnl / total staked
  bets: number;
  wins: number;
  hitRate: number;
  staked: number;
  equity: number[];   // bankroll after each match
}

export interface EngineState {
  startBankroll: number;
  matches: number;
  simsPerMatch: number;
  leaderboard: StratResult[];
}

function settle(bets: Bet[], score: [number, number]): { pnl: number; wins: number; staked: number } {
  let pnl = 0, wins = 0, staked = 0;
  for (const b of bets) {
    staked += b.stake;
    const r = settleBet(b, score[0], score[1]);
    pnl += r.pnl;
    if (r.win) wins++;
  }
  return { pnl, wins, staked };
}

export function runEngine(specs: MatchSpec[], simsPerMatch = 20, startBankroll = 1000, seedBase = 0): EngineState {
  const acc = STRATEGIES.map((s) => ({
    name: s.name, blurb: s.blurb, bankroll: startBankroll, pnl: 0, roi: 0,
    bets: 0, wins: 0, hitRate: 0, staked: 0, equity: [] as number[], strat: s,
  }));

  let matchCount = 0;
  for (let si = 0; si < simsPerMatch; si++) {
    for (let fi = 0; fi < specs.length; fi++) {
      const spec = specs[fi]!;
      const seed = seedBase + (fi + 1) * 100003 + (si + 1) * 7919;
      const sim = simulateMatch(spec.lambdaHome, spec.lambdaAway, seed);
      matchCount++;
      for (const a of acc) {
        const mem: Mem = {};
        const placed: Bet[] = [];
        let prev: MarketSnapshot | undefined;
        for (const snap of sim.snapshots) {
          const bet = a.strat.decide(snap, prev, mem, a.bankroll);
          if (bet && bet.stake > 0) placed.push(bet);
          prev = snap;
        }
        const { pnl, wins, staked } = settle(placed, sim.finalScore);
        a.bankroll += pnl; a.pnl += pnl; a.staked += staked; a.bets += placed.length; a.wins += wins;
        a.equity.push(Math.round(a.bankroll * 100) / 100);
      }
    }
  }

  const leaderboard: StratResult[] = acc
    .map(({ strat, ...r }) => ({
      ...r,
      pnl: Math.round(r.pnl * 100) / 100,
      bankroll: Math.round(r.bankroll * 100) / 100,
      roi: r.staked ? Math.round((r.pnl / r.staked) * 1000) / 10 : 0,
      hitRate: r.bets ? Math.round((r.wins / r.bets) * 1000) / 10 : 0,
      staked: Math.round(r.staked),
    }))
    .sort((x, y) => y.pnl - x.pnl);

  return { startBankroll, matches: matchCount, simsPerMatch, leaderboard };
}
