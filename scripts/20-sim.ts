import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { dataBase, dataHeaders } from "../src/ingest/auth.js";
import { normalizeFixture, normalizeOdds, normalizeScores, WORLD_CUP_COMPETITION_ID } from "../src/model/normalize.js";
import { inPlayProbs, lambdasFrom1x2 } from "../src/model/poisson.js";
import { runEngine, type MatchSpec } from "../src/agents/engine.js";
import { SIDES } from "../src/agents/types.js";

// Verified on-chain proofs from our devnet runs (see data/CHAIN.md).
const ONCHAIN = {
  network: "devnet",
  program: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
  intentTx: "2p6ub1ShSiojbqCvWcc6D2vYMDxi8NJXRSwyiSpyZsnDumLyhRuDWsJf62WkhTf1iuzaF9gq59Xj1sDUvXQ8gB46",
  validateTx: "neoJHaFxcmzgoicHrrvEDrfFyPFcQDoR2K9Y7Gmw7czHpkpsATN3oeToGag9BX6L5mrhCCCPy1M1oMLxvBj4R3U",
};

async function get(p: string) {
  const r = await fetch(`${dataBase()}${p}`, { headers: dataHeaders() });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}

async function main() {
  const fixturesRaw = (await get("/api/fixtures/snapshot")) as any[];
  const fixtures = fixturesRaw.filter((f) => f.CompetitionId === WORLD_CUP_COMPETITION_ID).map(normalizeFixture);

  const specs: MatchSpec[] = [];
  const liveBoard: any[] = [];
  for (const f of fixtures) {
    const [oddsRaw, scoresRaw] = await Promise.all([
      get(`/api/odds/snapshot/${f.fixtureId}`).catch(() => []),
      get(`/api/scores/snapshot/${f.fixtureId}`).catch(() => []),
    ]);
    const market = normalizeOdds(oddsRaw as any[], f.p1IsHome);
    if (!market) continue;
    const score = normalizeScores(scoresRaw as any[], f.p1IsHome);
    const { lambdaHome, lambdaAway } = lambdasFrom1x2(market.probs);
    specs.push({ label: `${f.home} v ${f.away}`, lambdaHome, lambdaAway });

    const model = inPlayProbs({
      minute: score?.minute ?? 0, homeGoals: score?.homeGoals ?? 0, awayGoals: score?.awayGoals ?? 0,
      preLambdaHome: lambdaHome, preLambdaAway: lambdaAway, redHome: score?.redHome, redAway: score?.redAway,
    });
    liveBoard.push({
      label: `${f.home} v ${f.away}`, fixtureId: f.fixtureId,
      minute: Math.round(score?.minute ?? 0), score: [score?.homeGoals ?? 0, score?.awayGoals ?? 0],
      inRunning: market.inRunning,
      model: SIDES.map((s) => +(model[s]).toFixed(3)),
      market: SIDES.map((s) => +(market.probs[s]).toFixed(3)),
      edge: SIDES.map((s) => +((model[s] - market.probs[s]) * 100).toFixed(1)),
    });
  }

  console.log(`fixtures with odds: ${specs.length}. Running engine...`);
  const engine = runEngine(specs, 25, 1000);

  const state = {
    generatedAtMs: Date.now(),
    track: "TxODDS World Cup — Trading Tools & Agents",
    ...engine,
    fixtures: liveBoard,
    onchain: ONCHAIN,
  };
  const dir = path.resolve("dashboard");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));

  console.log("\nLEADERBOARD (", engine.matches, "matches )");
  for (const s of engine.leaderboard)
    console.log(`  ${s.name.padEnd(13)} pnl=${String(s.pnl).padStart(9)}  roi=${String(s.roi).padStart(6)}%  bets=${String(s.bets).padStart(5)}  hit=${s.hitRate}%`);
  console.log("\nwrote dashboard/state.json");
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
