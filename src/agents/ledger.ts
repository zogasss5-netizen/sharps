import fs from "node:fs";
import path from "node:path";
import { settleBet, type Market } from "./types.js";

// Persistent paper-trading ledger.
//
// Two truth signals, both honest:
//  1. Closing Line Value (CLV) — each bet's entry odds vs where the line moves afterwards.
//     Positive CLV over many bets is the professional proof of edge (Pinnacle: +CLV ≈ profitable
//     regardless of win/loss variance). Computable LIVE — no match result needed.
//  2. Settled PnL — booked when a match finishes (delayed, needs the feed to complete a match).
//
// Persists to data/ledger.json across restarts.

export interface OpenBet {
  id: string; agent: string; fixtureId: number; label: string;
  market: Market; selection: string; line?: number;
  stake: number; oddsDecimal: number; placedTs: number; entryMinute: number; edgeBp: number;
  currentOdds?: number; clvPct?: number; // updated live by reprice()
}
export interface SettledBet extends OpenBet { settledTs: number; finalScore: [number, number]; pnl: number; result: "win" | "loss" | "push"; }
interface Data { startBankroll: number; open: OpenBet[]; settled: SettledBet[]; }

/** Look up the current offered odds for a given selection, or undefined if unavailable. */
export type OddsLookup = (fixtureId: number, market: Market, selection: string, line?: number) => number | undefined;

export class Ledger {
  data: Data;
  constructor(public file = path.resolve("data/ledger.json"), start = 1000) {
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { startBankroll: start, open: [], settled: [] };
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  bankroll(agent: string) { return this.data.startBankroll + this.data.settled.filter((s) => s.agent === agent).reduce((a, b) => a + b.pnl, 0); }
  private hasOpen(agent: string, fixtureId: number) { return this.data.open.some((o) => o.agent === agent && o.fixtureId === fixtureId); }

  place(b: Omit<OpenBet, "id">): boolean {
    if (this.hasOpen(b.agent, b.fixtureId)) return false;
    this.data.open.push({ ...b, id: `${b.agent}-${b.fixtureId}-${b.placedTs}` });
    return true;
  }

  /** Re-price open bets against the current line → live CLV. clv% = entryOdds/currentOdds − 1. */
  reprice(lookup: OddsLookup) {
    for (const o of this.data.open) {
      const cur = lookup(o.fixtureId, o.market, o.selection, o.line);
      if (cur && cur > 1) { o.currentOdds = cur; o.clvPct = +((o.oddsDecimal / cur - 1) * 100).toFixed(2); }
    }
  }

  settle(finals: Map<number, [number, number]>): number {
    const still: OpenBet[] = []; let n = 0;
    for (const o of this.data.open) {
      const fs2 = finals.get(o.fixtureId);
      if (!fs2) { still.push(o); continue; }
      const r = settleBet(o, fs2[0], fs2[1]);
      this.data.settled.push({ ...o, settledTs: Date.now(), finalScore: fs2, pnl: r.pnl, result: r.push ? "push" : r.win ? "win" : "loss" });
      n++;
    }
    this.data.open = still;
    return n;
  }

  /** Settled PnL leaderboard. */
  leaderboard() {
    const agents = [...new Set([...this.data.open.map((o) => o.agent), ...this.data.settled.map((s) => s.agent)])];
    return agents.map((a) => {
      const st = this.data.settled.filter((s) => s.agent === a);
      const pnl = st.reduce((x, y) => x + y.pnl, 0), staked = st.reduce((x, y) => x + y.stake, 0);
      const wins = st.filter((s) => s.result === "win").length;
      return {
        agent: a, pnl: Math.round(pnl * 100) / 100, settled: st.length,
        open: this.data.open.filter((o) => o.agent === a).length, wins,
        hitRate: st.length ? Math.round((wins / st.length) * 1000) / 10 : 0,
        roi: staked ? Math.round((pnl / staked) * 1000) / 10 : 0,
        bankroll: Math.round((this.data.startBankroll + pnl) * 100) / 100,
      };
    }).sort((x, y) => y.pnl - x.pnl);
  }

  /** CLV board — the live sharpness metric. Aggregates every bet that has been re-priced. */
  clvBoard() {
    const all = [...this.data.open, ...this.data.settled].filter((b) => typeof b.clvPct === "number");
    const agents = [...new Set(all.map((b) => b.agent))];
    return agents.map((a) => {
      const bets = all.filter((b) => b.agent === a);
      const avg = bets.reduce((x, y) => x + (y.clvPct ?? 0), 0) / bets.length;
      const beat = bets.filter((b) => (b.clvPct ?? 0) > 0).length;
      return {
        agent: a, n: bets.length,
        avgClv: +avg.toFixed(2),
        beatRate: +((beat / bets.length) * 100).toFixed(1),
      };
    }).sort((x, y) => y.avgClv - x.avgClv);
  }

  openPositions() {
    return [...this.data.open].sort((a, b) => b.placedTs - a.placedTs).map((o) => ({
      agent: o.agent, fixtureId: o.fixtureId, label: o.label, market: o.market, selection: o.selection, line: o.line,
      odds: +o.oddsDecimal.toFixed(2), stake: Math.round(o.stake), edgeBp: o.edgeBp,
      clvPct: o.clvPct ?? null, placedTs: o.placedTs,
    }));
  }
  /** All open bets keyed for the match view (full set, not sliced). */
  openByFixture() {
    return this.data.open.map((o) => ({
      id: o.id, agent: o.agent, fixtureId: o.fixtureId, label: o.label, market: o.market, selection: o.selection,
      line: o.line ?? null, odds: +o.oddsDecimal.toFixed(2), currentOdds: o.currentOdds != null ? +o.currentOdds.toFixed(2) : null,
      stake: Math.round(o.stake), clvPct: o.clvPct ?? null, placedTs: o.placedTs,
    }));
  }
  recentSettled(n = 12) {
    return [...this.data.settled].sort((a, b) => b.settledTs - a.settledTs).slice(0, n).map((s) => ({
      agent: s.agent, label: s.label, market: s.market, selection: s.selection, result: s.result, pnl: Math.round(s.pnl * 100) / 100, finalScore: s.finalScore,
    }));
  }
}
