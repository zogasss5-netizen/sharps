import { inPlayProbs, poissonPmf, type Outcome } from "../model/poisson.js";
import type { MarketSnapshot, Side } from "./types.js";

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function poisson(lambda: number, r: () => number): number { const L = Math.exp(-lambda); let k = 0, p = 1; do { k++; p *= r(); } while (p > L); return k - 1; }

const REG = 90, VIG = 0.05;
const LAG_X2 = 0.25, LAG_AH = 0.22, LAG_OU = 0.20; // each market lags the truth differently
const NOISE = 0.018;                                // per-market idiosyncratic noise -> dislocations
const MAXG = 10;

const outcomeOf = (h: number, a: number): Side => (h > a ? "home" : h < a ? "away" : "draw");
const clamp = (x: number) => Math.max(0.02, Math.min(0.98, x));
const rQuarter = (x: number) => Math.round(x * 4) / 4;
const rHalf = (x: number) => Math.round(x * 2) / 2;

/** Conditional P(home covers) from remaining-goal rates + current margin. */
function coverProb(remH: number, remA: number, curMargin: number, line: number): number {
  let over = 0, under = 0;
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
    const p = poissonPmf(h, remH) * poissonPmf(a, remA);
    const m = curMargin + h - a + line;
    if (m > 1e-9) over += p; else if (m < -1e-9) under += p;
  }
  return over / (over + under || 1);
}
/** Conditional P(total over line) from remaining-goal rates + current total. */
function overProb(remH: number, remA: number, curTotal: number, line: number): number {
  let over = 0, under = 0;
  for (let h = 0; h <= MAXG; h++) for (let a = 0; a <= MAXG; a++) {
    const p = poissonPmf(h, remH) * poissonPmf(a, remA);
    const t = curTotal + h + a - line;
    if (t > 1e-9) over += p; else if (t < -1e-9) under += p;
  }
  return over / (over + under || 1);
}

export interface SimResult { snapshots: MarketSnapshot[]; final: Side; finalScore: [number, number]; }

export function simulateMatch(lambdaHome: number, lambdaAway: number, seed: number): SimResult {
  const r = rng(seed);
  const perMinH = lambdaHome / REG, perMinA = lambdaAway / REG;
  let h = 0, a = 0;
  const snapshots: MarketSnapshot[] = [];

  let mX2: Outcome = inPlayProbs({ minute: 0, homeGoals: 0, awayGoals: 0, preLambdaHome: lambdaHome, preLambdaAway: lambdaAway });
  let mAhCover = 0.5, mOver = 0.5, init = false;

  for (let m = 0; m <= REG; m++) {
    if (m > 0) { h += poisson(perMinH, r); a += poisson(perMinA, r); }
    const frac = (REG - m) / REG;
    const remH = lambdaHome * frac, remA = lambdaAway * frac;
    const model = inPlayProbs({ minute: m, homeGoals: h, awayGoals: a, preLambdaHome: lambdaHome, preLambdaAway: lambdaAway });

    // main lines kept near 50/50
    const ahLine = -rQuarter((remH - remA) + (h - a));
    const ouLine = Math.max(0.5, rHalf((h + a) + remH + remA));
    const trueCover = coverProb(remH, remA, h - a, ahLine);
    const trueOver = overProb(remH, remA, h + a, ouLine);
    if (!init) { mAhCover = trueCover; mOver = trueOver; init = true; }

    mX2 = { home: mX2.home + LAG_X2 * (model.home - mX2.home), draw: mX2.draw + LAG_X2 * (model.draw - mX2.draw), away: mX2.away + LAG_X2 * (model.away - mX2.away) };
    mAhCover = clamp(mAhCover + LAG_AH * (trueCover - mAhCover) + (r() - 0.5) * NOISE);
    mOver = clamp(mOver + LAG_OU * (trueOver - mOver) + (r() - 0.5) * NOISE);

    const vigOdds = (p: number) => 1 / (clamp(p) * (1 + VIG));
    snapshots.push({
      minute: m, score: [h, a], model,
      marketProb: mX2, marketOdds: { home: vigOdds(mX2.home), draw: vigOdds(mX2.draw), away: vigOdds(mX2.away) },
      ah: { line: ahLine, coverModel: trueCover, coverMarket: mAhCover, oddsHome: vigOdds(mAhCover), oddsAway: vigOdds(1 - mAhCover) },
      ou: { line: ouLine, overModel: trueOver, overMarket: mOver, oddsOver: vigOdds(mOver), oddsUnder: vigOdds(1 - mOver) },
    });
  }
  return { snapshots, final: outcomeOf(h, a), finalScore: [h, a] };
}
