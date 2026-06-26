import fs from "node:fs";
import path from "node:path";
import { settleBet, type Market } from "./types.js";

// Persistent paper-trading ledger. Agents place REAL bets at live odds (visible immediately);
// the settler books real PnL when a fixture finishes. This is the honest "live PnL" — delayed
// by match completion, not simulated. Persists to data/ledger.json across runs.

export interface OpenBet {
  id: string; agent: string; fixtureId: number; label: string;
  market: Market; selection: string; line?: number;
  stake: number; oddsDecimal: number; placedTs: number; entryMinute: number; edgeBp: number;
}
export interface SettledBet extends OpenBet { settledTs: number; finalScore: [number, number]; pnl: number; result: "win" | "loss" | "push"; }
interface Data { startBankroll: number; open: OpenBet[]; settled: SettledBet[]; }

export class Ledger {
  data: Data;
  constructor(public file = path.resolve("data/ledger.json"), start = 1000) {
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { startBankroll: start, open: [], settled: [] };
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2)); }
  bankroll(agent: string) { return this.data.startBankroll + this.data.settled.filter((s) => s.agent === agent).reduce((a, b) => a + b.pnl, 0); }
  private hasOpen(agent: string, fixtureId: number) { return this.data.open.some((o) => o.agent === agent && o.fixtureId === fixtureId); }

  /** Place a bet if this agent has no open position on this fixture. Returns true if placed. */
  place(b: Omit<OpenBet, "id">): boolean {
    if (this.hasOpen(b.agent, b.fixtureId)) return false;
    this.data.open.push({ ...b, id: `${b.agent}-${b.fixtureId}-${b.placedTs}` });
    return true;
  }
  /** Settle open bets whose fixture is final. finals: fixtureId -> [home,away]. Returns count settled. */
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
  openPositions() {
    return [...this.data.open].sort((a, b) => b.placedTs - a.placedTs).map((o) => ({
      agent: o.agent, label: o.label, market: o.market, selection: o.selection, line: o.line,
      odds: +o.oddsDecimal.toFixed(2), stake: Math.round(o.stake), edgeBp: o.edgeBp, placedTs: o.placedTs,
    }));
  }
  recentSettled(n = 12) {
    return [...this.data.settled].sort((a, b) => b.settledTs - a.settledTs).slice(0, n).map((s) => ({
      agent: s.agent, label: s.label, market: s.market, selection: s.selection, result: s.result, pnl: Math.round(s.pnl * 100) / 100, finalScore: s.finalScore,
    }));
  }
}
