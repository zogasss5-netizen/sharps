import "dotenv/config";
import { dataBase, dataHeaders } from "../src/ingest/auth.js";
import {
  normalizeFixture, normalizeOdds, normalizeScores, WORLD_CUP_COMPETITION_ID,
} from "../src/model/normalize.js";
import { inPlayProbs, lambdasFrom1x2, type Outcome } from "../src/model/poisson.js";

// Live demo: for every World Cup fixture with odds, derive pre-match lambdas from the
// consensus 1X2, compute the in-play model probabilities from the current score, and
// show the EDGE = model - market. This is the signal the agents will trade on.

const TOTAL_GOALS_PRIOR = 2.6; // WC baseline; later calibrated per-fixture if a totals market exists.

async function get(path: string) {
  const r = await fetch(`${dataBase()}${path}`, { headers: dataHeaders() });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

const pct = (x: number) => (x * 100).toFixed(1).padStart(5) + "%";
function edgeLine(name: string, model: Outcome, market: Outcome) {
  const e = (k: keyof Outcome) => {
    const d = model[k] - market[k];
    return (d >= 0 ? "+" : "") + (d * 100).toFixed(1) + "%";
  };
  console.log(`  ${name.padEnd(34)} model[H/D/A]=${pct(model.home)}/${pct(model.draw)}/${pct(model.away)}  market=${pct(market.home)}/${pct(market.draw)}/${pct(market.away)}  edge=${e("home")}/${e("draw")}/${e("away")}`);
}

async function main() {
  const fixturesRaw = await get("/api/fixtures/snapshot");
  const fixtures = (fixturesRaw as any[])
    .filter((f) => f.CompetitionId === WORLD_CUP_COMPETITION_ID)
    .map(normalizeFixture);
  console.log(`World Cup fixtures: ${fixtures.length}\n`);

  let withSignal = 0;
  for (const f of fixtures) {
    const [oddsRaw, scoresRaw] = await Promise.all([
      get(`/api/odds/snapshot/${f.fixtureId}`),
      get(`/api/scores/snapshot/${f.fixtureId}`),
    ]);
    const market = normalizeOdds(oddsRaw as any[], f.p1IsHome);
    const score = normalizeScores(scoresRaw as any[], f.p1IsHome);
    if (!market) continue;

    // Pre-match lambdas from the consensus 1X2 (best available proxy for team strengths).
    const { lambdaHome, lambdaAway } = lambdasFrom1x2(market.probs, TOTAL_GOALS_PRIOR);

    const min = score?.minute ?? 0;
    const sc = score ? `${score.homeGoals}-${score.awayGoals} @${min.toFixed(0)}'` : "no score";
    const model = inPlayProbs({
      minute: min,
      homeGoals: score?.homeGoals ?? 0,
      awayGoals: score?.awayGoals ?? 0,
      preLambdaHome: lambdaHome,
      preLambdaAway: lambdaAway,
      redHome: score?.redHome,
      redAway: score?.redAway,
    });
    console.log(`${f.home} v ${f.away}  [${sc}] inRunning=${market.inRunning}  λ=${lambdaHome.toFixed(2)}/${lambdaAway.toFixed(2)}`);
    edgeLine("", model, market.probs);
    withSignal++;
  }
  console.log(`\n${withSignal} fixtures with a model-vs-market signal.`);
}

main().catch((e) => { console.error("edge demo failed:", e.message ?? e); process.exit(1); });
