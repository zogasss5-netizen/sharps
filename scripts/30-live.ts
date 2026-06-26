import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { BN } from "@coral-xyz/anchor";
import { dataBase, dataHeaders } from "../src/ingest/auth.js";
import { buildTick, currentOddsLookup, type LiveFixture, type Signal } from "../src/agents/live.js";
import { runEngine, type MatchSpec } from "../src/agents/engine.js";
import { loadKeypair } from "../src/chain/client.js";
import { postIntent, ensureUsdtAta } from "../src/chain/venue.js";
import { Ledger } from "../src/agents/ledger.js";
import { normalizeScores } from "../src/model/normalize.js";

const TICK_MS = +(process.env.TICK_MS ?? 25_000);
const MAX_TICKS = +(process.env.MAX_TICKS ?? 45);
const REDEPLOY_EVERY = +(process.env.REDEPLOY_EVERY ?? 6);
const MAX_INTENTS = +(process.env.MAX_INTENTS ?? 6);
const ONCHAIN_BP = +(process.env.ONCHAIN_BP ?? 250);
const OUT = path.resolve("dashboard/state.json");

async function get(p: string) { const r = await fetch(`${dataBase()}${p}`, { headers: dataHeaders() }); return r.ok ? r.json() : []; }
const sh = (cmd: string, args: string[]) => new Promise<void>((res) => execFile(cmd, args, { cwd: process.cwd() }, () => res()));

async function fetchRows() {
  const fixtures = (await get("/api/fixtures/snapshot")) as any[];
  return Promise.all(fixtures.map(async (fixture) => {
    const [odds, scores] = await Promise.all([
      get(`/api/odds/snapshot/${fixture.FixtureId}`).catch(() => []),
      get(`/api/scores/snapshot/${fixture.FixtureId}`).catch(() => []),
    ]);
    return { fixture, odds: odds as any[], scores: scores as any[] };
  }));
}

function liveBoard(fixtures: LiveFixture[]) {
  const S = ["home", "draw", "away"] as const;
  return fixtures.map((f) => ({
    label: f.label, fixtureId: f.fixtureId, period: f.period, minute: f.minute, score: f.score, inRunning: f.inRunning,
    present: f.present, joint: f.jointLambda,
    model: S.map((s) => +f.model[s].toFixed(3)),
    market: f.marketX2 ? S.map((s) => +f.marketX2![s].toFixed(3)) : null,
    cross: f.cross.slice(0, 3).map((d) => ({ market: d.market, detail: d.detail, bp: d.residualBp })),
  }));
}

async function main() {
  const A = loadKeypair();
  await ensureUsdtAta(A);
  console.log("live engine wallet:", A.publicKey.toBase58());

  const ledger = new Ledger();
  let prev: Map<number, LiveFixture> | undefined;
  let feed: Signal[] = [];
  const onchainIntents: any[] = [];
  let engine = runEngine([{ label: "warmup", lambdaHome: 1.3, lambdaAway: 1.1 }], 1, 1000);

  for (let t = 1; t <= MAX_TICKS; t++) {
    const now = Date.now();
    let rows;
    try { rows = await fetchRows(); } catch (e) { console.warn("fetch err", (e as Error).message); await wait(TICK_MS); continue; }
    const lt = buildTick(rows, prev, now);
    prev = new Map(lt.fixtures.map((f) => [f.fixtureId, f]));
    feed = [...lt.signals, ...feed].slice(0, 40);

    // --- real paper ledger: place bets at live odds, settle finished fixtures ---
    const minuteOf = new Map(lt.fixtures.map((f) => [f.fixtureId, f.minute]));
    let placed = 0;
    for (const sig of lt.signals) {
      if (!sig.selection || !sig.oddsDecimal) continue;
      const stake = 0.02 * ledger.bankroll(sig.agent);
      if (ledger.place({ agent: sig.agent, fixtureId: sig.fixtureId, label: sig.fixture, market: sig.market as any, selection: sig.selection, line: sig.line, stake, oddsDecimal: sig.oddsDecimal, placedTs: now, entryMinute: minuteOf.get(sig.fixtureId) ?? 0, edgeBp: sig.edgeBp })) placed++;
    }
    const finals = new Map<number, [number, number]>();
    for (const { fixture, scores } of rows) {
      const sc = normalizeScores(scores, !!fixture.Participant1IsHome);
      const gs = String(sc?.gameState ?? "").toLowerCase();
      const terminal = /end|finish|ft|full|result|complete/.test(gs) || (!!sc && sc.minute >= 93);
      if (sc && terminal) finals.set(fixture.FixtureId, [sc.homeGoals, sc.awayGoals]);
    }
    ledger.reprice(currentOddsLookup(rows)); // live CLV
    const settledN = ledger.settle(finals);
    ledger.save();

    // recompute the sim leaderboard off the live joint lambdas (so settled-PnL stays current)
    const specs: MatchSpec[] = lt.fixtures.map((f) => ({ label: f.label, lambdaHome: f.jointLambda[0], lambdaAway: f.jointLambda[1] }));
    if (specs.length) engine = runEngine(specs, 20, 1000);

    // on-chain: commit capital on the strongest fresh cross-market dislocation
    if (onchainIntents.length < MAX_INTENTS) {
      const c = lt.signals.filter((s) => s.agent === "cross-arb" && Math.abs(s.edgeBp) >= ONCHAIN_BP)
        .sort((a, b) => Math.abs(b.edgeBp) - Math.abs(a.edgeBp))[0];
      const fx = c && lt.fixtures.find((f) => f.label === c.fixture);
      if (c && fx) {
        try {
          const intentId = Date.now();
          const termsHash = Array.from(crypto.createHash("sha256").update(`${c.market}:${fx.fixtureId}:${c.side}`).digest());
          const r = await postIntent(A, { intentId, termsHash, deposit: 1_000_000, expirationTs: Math.floor(Date.now() / 1000) + 7 * 24 * 3600, claimPeriod: 200, fixtureId: fx.fixtureId });
          const rec = { ts: now, fixture: c.fixture, market: c.market, side: c.side, edgeBp: c.edgeBp, tx: r.sig };
          onchainIntents.unshift(rec);
          feed.unshift({ ts: now, agent: "cross-arb", fixture: c.fixture, fixtureId: fx.fixtureId, market: c.market, side: c.side, detail: "ON-CHAIN intent posted", edgeBp: c.edgeBp, onchain: r.sig });
          console.log(`  on-chain intent #${onchainIntents.length}:`, c.fixture, c.market, c.side, `${c.edgeBp}bp`, r.sig.slice(0, 12));
        } catch (e) { console.warn("  intent post failed:", (e as Error).message?.slice(0, 80)); }
      }
    }

    const state = {
      generatedAtMs: now, track: "TxODDS World Cup — Trading Tools & Agents",
      ...engine,
      fixtures: liveBoard(lt.fixtures),
      live: { tick: t, maxTicks: MAX_TICKS, signals: lt.signals.length, feed: feed.slice(0, 24) },
      ledger: {
        startBankroll: 1000,
        leaderboard: ledger.leaderboard(),
        clv: ledger.clvBoard(),
        open: ledger.openPositions().slice(0, 12),
        settled: ledger.recentSettled(10),
        openCount: ledger.openPositions().length,
      },
      onchain: {
        network: "devnet", program: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
        intentTx: "2p6ub1ShSiojbqCvWcc6D2vYMDxi8NJXRSwyiSpyZsnDumLyhRuDWsJf62WkhTf1iuzaF9gq59Xj1sDUvXQ8gB46",
        validateTx: "neoJHaFxcmzgoicHrrvEDrfFyPFcQDoR2K9Y7Gmw7czHpkpsATN3oeToGag9BX6L5mrhCCCPy1M1oMLxvBj4R3U",
        liveIntents: onchainIntents.slice(0, 8),
      },
    };
    fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
    console.log(`tick ${t}/${MAX_TICKS}  fixtures=${lt.fixtures.length}  signals=${lt.signals.length}  placed=${placed}  settled=${settledN}  open=${ledger.openPositions().length}  intents=${onchainIntents.length}`);

    if (t % REDEPLOY_EVERY === 0) {
      await sh("git", ["add", "dashboard/state.json"]);
      await sh("git", ["-c", "user.name=zogasss5-netizen", "-c", "user.email=258506098+zogasss5-netizen@users.noreply.github.com", "commit", "-q", "-m", `live: tick ${t}`]);
      await sh("git", ["subtree", "push", "--prefix", "dashboard", "origin", "gh-pages"]);
      console.log(`  redeployed @ tick ${t}`);
    }
    if (t < MAX_TICKS) await wait(TICK_MS);
  }
  console.log("live session complete.");
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
