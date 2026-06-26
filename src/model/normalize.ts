// Normalize raw TxLINE odds/scores payloads into the clean types the model uses.
// Schemas captured live from devnet (see data/SCHEMA.md).

import type { Outcome } from "./poisson.js";

export const WORLD_CUP_COMPETITION_ID = 72;
const DEMARGINED = "TXLineStablePriceDemargined"; // consensus fair (de-vigged) book
const MARKET_1X2 = "1X2_PARTICIPANT_RESULT";

export interface Fixture {
  fixtureId: number;
  competitionId: number;
  startTime: number;
  home: string;
  away: string;
  p1IsHome: boolean;
}

export interface MarketLine {
  ts: number;
  inRunning: boolean;
  /** consensus fair probabilities, mapped to home/draw/away */
  probs: Outcome;
  decimal: { home: number; draw: number; away: number };
}

export interface ScoreState {
  ts: number;
  seq: number;
  gameState: string | null;
  minute: number; // match minute (Clock.Seconds / 60)
  homeGoals: number;
  awayGoals: number;
  redHome: number;
  redAway: number;
}

export function normalizeFixture(f: any): Fixture {
  return {
    fixtureId: f.FixtureId,
    competitionId: f.CompetitionId,
    startTime: f.StartTime,
    home: f.Participant1IsHome ? f.Participant1 : f.Participant2,
    away: f.Participant1IsHome ? f.Participant2 : f.Participant1,
    p1IsHome: !!f.Participant1IsHome,
  };
}

/** Pick the latest de-margined 1X2 line from an odds snapshot/stream array. */
export function normalizeOdds(rows: any[], p1IsHome: boolean): MarketLine | null {
  const lines = rows
    .filter((r) => r.SuperOddsType === MARKET_1X2 && typeof r.Bookmaker === "string" && r.Bookmaker.includes("Demargined"))
    .sort((a, b) => b.Ts - a.Ts);
  const r = lines[0] ?? rows.filter((x) => x.SuperOddsType === MARKET_1X2).sort((a, b) => b.Ts - a.Ts)[0];
  if (!r || !Array.isArray(r.Prices) || r.Prices.length < 3) return null;

  // PriceNames = [part1, draw, part2]; Prices = decimal odds * 1000.
  const dec = r.Prices.map((p: number) => p / 1000);
  const inv = dec.map((d: number) => (d > 0 ? 1 / d : 0));
  const s = inv[0] + inv[1] + inv[2] || 1;
  const part1 = inv[0] / s, draw = inv[1] / s, part2 = inv[2] / s;

  const probs: Outcome = p1IsHome
    ? { home: part1, draw, away: part2 }
    : { home: part2, draw, away: part1 };
  const decimal = p1IsHome
    ? { home: dec[0], draw: dec[1], away: dec[2] }
    : { home: dec[2], draw: dec[1], away: dec[0] };

  return { ts: r.Ts, inRunning: !!r.InRunning, probs, decimal };
}

const goalsOf = (side: any): number => side?.Total?.Goals ?? 0;
const redsOf = (side: any): number => side?.Total?.RedCards ?? 0;

/** Latest score state from a scores snapshot/stream array. */
export function normalizeScores(rows: any[], p1IsHome: boolean): ScoreState | null {
  const r = [...rows].sort((a, b) => (b.Seq ?? 0) - (a.Seq ?? 0))[0];
  if (!r) return null;
  const p1 = r.Score?.Participant1, p2 = r.Score?.Participant2;
  const homeSide = p1IsHome ? p1 : p2, awaySide = p1IsHome ? p2 : p1;
  const seconds = r.Clock?.Seconds ?? 0;
  return {
    ts: r.Ts,
    seq: r.Seq ?? 0,
    gameState: r.GameState ?? null,
    minute: seconds / 60,
    homeGoals: goalsOf(homeSide),
    awayGoals: goalsOf(awaySide),
    redHome: redsOf(homeSide),
    redAway: redsOf(awaySide),
  };
}
