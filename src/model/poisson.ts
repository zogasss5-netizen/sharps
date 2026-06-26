// In-play 1X2 win-probability engine — the core of the model.
//
// Standard, defensible approach (in-play Poisson / Dixon-Coles):
//   1. From de-vigged pre-match 1X2 odds, back out each side's expected goals (lambda).
//   2. In-play: remaining goals for each side ~ Poisson(lambda * fractionOfMatchLeft),
//      adjusted for red cards. Convolve with the CURRENT score to get P(H/D/A).
// Everything here is pure + deterministic so it can be unit-tested and calibrated.

export interface Outcome {
  home: number;
  draw: number;
  away: number;
}

export interface MatchState {
  minute: number; // elapsed match minute (0..90+)
  homeGoals: number;
  awayGoals: number;
  preLambdaHome: number; // pre-match expected goals, full match
  preLambdaAway: number;
  redHome?: number; // red cards conceded by each side (reduces their attack)
  redAway?: number;
  regulation?: number; // full-time minutes, default 90
}

const MAX_GOALS = 12;

export function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  // exp(-l) * l^k / k!
  let logp = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logp -= Math.log(i);
  return Math.exp(logp);
}

/** Dixon-Coles low-score dependence correction factor tau(h,a). rho=0 disables it. */
function tau(h: number, a: number, lh: number, la: number, rho: number): number {
  if (rho === 0) return 1;
  if (h === 0 && a === 0) return 1 - lh * la * rho;
  if (h === 0 && a === 1) return 1 + lh * rho;
  if (h === 1 && a === 0) return 1 + la * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}

/**
 * Outcome probabilities given expected REMAINING goals for each side and the
 * current score. Sums the joint scoreline distribution of remaining goals.
 */
export function outcomeProbs(
  remLambdaHome: number,
  remLambdaAway: number,
  curHome = 0,
  curAway = 0,
  rho = 0,
): Outcome {
  const ph: number[] = [];
  const pa: number[] = [];
  for (let k = 0; k <= MAX_GOALS; k++) {
    ph[k] = poissonPmf(k, remLambdaHome);
    pa[k] = poissonPmf(k, remLambdaAway);
  }
  let home = 0, draw = 0, away = 0, total = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = ph[h]! * pa[a]! * tau(h, a, remLambdaHome, remLambdaAway, rho);
      total += p;
      const fh = curHome + h, fa = curAway + a;
      if (fh > fa) home += p;
      else if (fh === fa) draw += p;
      else away += p;
    }
  }
  // renormalize (truncation + tau)
  return { home: home / total, draw: draw / total, away: away / total };
}

/** Full live 1X2 from a match state. */
export function inPlayProbs(s: MatchState, rho = 0): Outcome {
  const reg = s.regulation ?? 90;
  const frac = Math.max(0, Math.min(1, (reg - s.minute) / reg));
  // Red cards depress the offending side's remaining scoring (~15% per card, simple+robust).
  const redMul = (n = 0) => Math.pow(0.85, n);
  const remH = s.preLambdaHome * frac * redMul(s.redHome);
  const remA = s.preLambdaAway * frac * redMul(s.redAway);
  return outcomeProbs(remH, remA, s.homeGoals, s.awayGoals, rho);
}

/** Proportional de-vig: strip the overround from 1X2 decimal odds → true probs. */
export function devig(oddsHome: number, oddsDraw: number, oddsAway: number): Outcome {
  const ih = 1 / oddsHome, id = 1 / oddsDraw, ia = 1 / oddsAway;
  const s = ih + id + ia;
  return { home: ih / s, draw: id / s, away: ia / s };
}

/**
 * Back out pre-match expected goals (lambdaHome, lambdaAway) consistent with a
 * de-vigged 1X2. Full 2D fit over (lambdaHome, lambdaAway) — fits all of H/D/A,
 * so a high-draw market maps to a low total (it does NOT force a fixed total).
 * Coarse grid then local refine.
 */
export function lambdasFrom1x2(
  target: Outcome,
  _totalGoalsHint = 2.6,
  rho = 0,
): { lambdaHome: number; lambdaAway: number; err: number } {
  const err = (lh: number, la: number) => {
    const p = outcomeProbs(lh, la, 0, 0, rho);
    return (p.home - target.home) ** 2 + (p.draw - target.draw) ** 2 + (p.away - target.away) ** 2;
  };
  let best = { lambdaHome: 1.3, lambdaAway: 1.3, err: Infinity };
  // coarse grid
  for (let lh = 0.1; lh <= 3.6; lh += 0.1) {
    for (let la = 0.1; la <= 3.6; la += 0.1) {
      const e = err(lh, la);
      if (e < best.err) best = { lambdaHome: lh, lambdaAway: la, err: e };
    }
  }
  // local refine around the best cell
  const { lambdaHome: ch, lambdaAway: ca } = best;
  for (let lh = ch - 0.1; lh <= ch + 0.1; lh += 0.02) {
    for (let la = ca - 0.1; la <= ca + 0.1; la += 0.02) {
      if (lh <= 0 || la <= 0) continue;
      const e = err(lh, la);
      if (e < best.err) best = { lambdaHome: lh, lambdaAway: la, err: e };
    }
  }
  return best;
}

// ----------------------------------------------------------------------------
// self-test:  npm run model:selftest
// ----------------------------------------------------------------------------
function approx(a: number, b: number, eps = 1e-2): boolean {
  return Math.abs(a - b) < eps;
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("  ok:", msg);
}

function selftest() {
  console.log("poisson pmf sums ~1");
  let s = 0;
  for (let k = 0; k <= MAX_GOALS; k++) s += poissonPmf(k, 1.4);
  assert(approx(s, 1, 1e-3), `sum_k P(k|1.4)=${s.toFixed(5)}`);

  console.log("symmetric teams -> home≈away, draw sizable");
  const sym = outcomeProbs(1.3, 1.3, 0, 0);
  assert(approx(sym.home, sym.away), `home=${sym.home.toFixed(3)} away=${sym.away.toFixed(3)}`);
  assert(sym.draw > 0.2, `draw=${sym.draw.toFixed(3)} > 0.2`);

  console.log("leading 1-0 at 80' is strong favorite");
  const lead = inPlayProbs({ minute: 80, homeGoals: 1, awayGoals: 0, preLambdaHome: 1.5, preLambdaAway: 1.1 });
  assert(lead.home > 0.8, `home win=${lead.home.toFixed(3)} > 0.8`);

  console.log("0-0 at 90' -> certain draw");
  const end = inPlayProbs({ minute: 90, homeGoals: 0, awayGoals: 0, preLambdaHome: 1.5, preLambdaAway: 1.2 });
  assert(approx(end.draw, 1, 1e-6), `draw=${end.draw}`);

  console.log("lambdasFrom1x2 round-trips");
  const truth = outcomeProbs(1.7, 1.0, 0, 0);
  const got = lambdasFrom1x2(truth, 2.7);
  assert(approx(got.lambdaHome, 1.7, 0.06) && approx(got.lambdaAway, 1.0, 0.06),
    `recovered lh=${got.lambdaHome.toFixed(2)} la=${got.lambdaAway.toFixed(2)} (err=${got.err.toExponential(1)})`);

  console.log("devig normalizes to 1");
  const dv = devig(2.0, 3.4, 4.0);
  assert(approx(dv.home + dv.draw + dv.away, 1, 1e-9), "sum=1");

  console.log("\nALL MODEL SELF-TESTS PASSED ✅");
}

if (process.argv[1] && process.argv[1].endsWith("poisson.ts")) selftest();
