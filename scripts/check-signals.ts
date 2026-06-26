import "dotenv/config";
import { dataBase, dataHeaders } from "../src/ingest/auth.js";
import { buildTick } from "../src/agents/live.js";

async function get(p: string) { const r = await fetch(`${dataBase()}${p}`, { headers: dataHeaders() }); return r.ok ? r.json() : []; }
const fixtures = (await get("/api/fixtures/snapshot")) as any[];
const rows = await Promise.all(fixtures.map(async (fixture) => {
  const [odds, scores] = await Promise.all([get(`/api/odds/snapshot/${fixture.FixtureId}`), get(`/api/scores/snapshot/${fixture.FixtureId}`)]);
  return { fixture, odds: odds as any[], scores: scores as any[] };
}));
const lt = buildTick(rows, undefined, Date.now());
const byAgent: Record<string, number> = {};
console.log(`signals: ${lt.signals.length}\n`);
for (const s of lt.signals.sort((a, b) => Math.abs(b.edgeBp) - Math.abs(a.edgeBp))) {
  byAgent[s.agent] = (byAgent[s.agent] ?? 0) + 1;
  console.log(`[${s.agent.padEnd(13)}] ${s.fixture.padEnd(28)} ${s.market} ${s.side}${s.line != null ? " " + s.line : ""} @${(s.oddsDecimal ?? 0).toFixed(2)}  edge ${s.edgeBp >= 0 ? "+" : ""}${s.edgeBp}bp`);
}
console.log("\nby agent:", JSON.stringify(byAgent));
const max = Math.max(0, ...lt.signals.map((s) => Math.abs(s.edgeBp)));
console.log("max |edge|:", max, "bp", max > 1600 ? "⚠ STILL TOO BIG" : "✓ bounded");
