import type { MatchSpec } from "./engine.js";

/**
 * A representative World-Cup-like fixture card: supremacy from heavy-favourite to even,
 * totals 2.2–3.0 expected goals. Used so the leaderboard/backtest is statistically
 * meaningful even when the live devnet feed only exposes a handful of fixtures with odds.
 */
export function representativeCard(): MatchSpec[] {
  const out: MatchSpec[] = [];
  const totals = [2.2, 2.6, 3.0];
  const supremacies = [1.6, 1.1, 0.7, 0.3, 0.0, -0.4, -0.9, -1.4];
  for (const tot of totals)
    for (const sup of supremacies) {
      const lambdaHome = Math.max(0.25, (tot + sup) / 2);
      const lambdaAway = Math.max(0.25, (tot - sup) / 2);
      out.push({ label: `card_xg${tot}_sup${sup}`, lambdaHome, lambdaAway });
    }
  return out; // 24 fixtures
}
