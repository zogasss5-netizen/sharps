/**
 * Proper backtest: run many independent "seasons" and report the DISTRIBUTION of outcomes
 * per agent — median, downside (p5), upside (p95), worst case, ruin rate, % profitable.
 * Aggressive Kelly has fat tails, so a single ROI number lies; this shows the real shape.
 *
 * Self-contained + reproducible: a fixed spread of realistic football fixtures (varied goal
 * rates from heavy favourite to even), each replayed under fresh seeds every season.
 *
 *   npm run backtest            # 400 seasons
 *   npm run backtest -- 1000    # custom season count
 */
import { runEngine } from "../src/agents/engine.js";
import { representativeCard } from "../src/agents/card.js";

const START = 1000;
const SEASONS = Number(process.argv[2] ?? 400);
const fixtures = representativeCard;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]!;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function main() {
  const specs = fixtures();
  const names = runEngine(specs, 1, START, 1).leaderboard.map((r) => r.name);

  const finals: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  const betsArr: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));
  const roiArr: Record<string, number[]> = Object.fromEntries(names.map((n) => [n, []]));

  for (let k = 0; k < SEASONS; k++) {
    const lb = runEngine(specs, 1, START, 1 + k * 100019).leaderboard;
    for (const r of lb) {
      finals[r.name]!.push(r.bankroll);
      betsArr[r.name]!.push(r.bets);
      roiArr[r.name]!.push(r.roi);
    }
  }

  console.log(`\nBACKTEST — ${SEASONS} seasons × ${specs.length} fixtures, start $${START}, compounding within a season\n`);
  const H = ["agent", "median", "p5(down)", "p95(up)", "worst", "profit%", "ruin%", "bets/szn", "medROI%"];
  console.log(H.map((h, i) => (i ? h.padStart(11) : h.padEnd(12))).join(""));
  for (const n of names) {
    const f = finals[n]!;
    const profit = (100 * f.filter((x) => x > START).length) / f.length;
    const ruin = (100 * f.filter((x) => x < START * 0.5).length) / f.length; // lost half+
    const row = [
      n.padEnd(12),
      `$${Math.round(pct(f, 0.5))}`.padStart(11),
      `$${Math.round(pct(f, 0.05))}`.padStart(11),
      `$${Math.round(pct(f, 0.95))}`.padStart(11),
      `$${Math.round(Math.min(...f))}`.padStart(11),
      `${profit.toFixed(0)}%`.padStart(11),
      `${ruin.toFixed(0)}%`.padStart(11),
      `${Math.round(mean(betsArr[n]!))}`.padStart(11),
      `${Math.round(mean(roiArr[n]!) * 10) / 10}%`.padStart(11),
    ];
    console.log(row.join(""));
  }
  console.log("\nmedian = typical season · p5 = unlucky season · ruin% = seasons that lost half+ · medROI = median return on stake");
}
main();
