import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { dataBase, dataHeaders } from "../src/ingest/auth.js";
import { buildTick, currentOddsLookup, type LiveFixture, type Signal } from "../src/agents/live.js";
import { runEngine, type MatchSpec } from "../src/agents/engine.js";
import { loadKeypair } from "../src/chain/client.js";
import { postIntent, ensureUsdtAta } from "../src/chain/venue.js";
import { Ledger } from "../src/agents/ledger.js";
import { normalizeScores } from "../src/model/normalize.js";

// Durable, restart-safe tracker. Runs forever (until stopped). Polls the live TxLINE feed,
// records every match lifecycle event (kickoff / goal / full-time) + every bet + settlement
// into a persistent backlog (data/events.jsonl), settles real PnL when matches finish, and
// keeps the deployed dashboard fresh. Devnet only.

const POLL_MS = +(process.env.POLL_MS ?? 30_000);
const HEARTBEAT = +(process.env.HEARTBEAT_TICKS ?? 40);   // redeploy at least this often (~20 min)
const ONCHAIN_EVERY = +(process.env.ONCHAIN_EVERY ?? 80); // ~40 min
const ONCHAIN_CAP = +(process.env.ONCHAIN_CAP ?? 20);
const ONCHAIN_BP = +(process.env.ONCHAIN_BP ?? 250);

const OUT = path.resolve("dashboard/state.json");
const EVENTS = path.resolve("data/events.jsonl");
const MSTATE = path.resolve("data/matchstate.json");

type Phase = "pre" | "live" | "done";
interface MState { phase: Phase; score: [number, number]; minute: number; gameState: string }

const sh = (a: string[]) => new Promise<void>((res) => execFile("git", a, { cwd: process.cwd() }, () => res()));
async function get(p: string) { const r = await fetch(`${dataBase()}${p}`, { headers: dataHeaders() }); return r.ok ? r.json() : []; }
function loadJson<T>(f: string, d: T): T { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }
function appendEvent(e: any) { fs.mkdirSync(path.dirname(EVENTS), { recursive: true }); fs.appendFileSync(EVENTS, JSON.stringify(e) + "\n"); }
function recentEvents(n = 40) { try { return fs.readFileSync(EVENTS, "utf8").trim().split("\n").filter(Boolean).slice(-n).map((l) => JSON.parse(l)).reverse(); } catch { return []; } }

async function fetchRows() {
  const fixtures = (await get("/api/fixtures/snapshot")) as any[];
  return Promise.all(fixtures.map(async (fixture) => {
    const [odds, scores] = await Promise.all([get(`/api/odds/snapshot/${fixture.FixtureId}`).catch(() => []), get(`/api/scores/snapshot/${fixture.FixtureId}`).catch(() => [])]);
    return { fixture, odds: odds as any[], scores: scores as any[] };
  }));
}
function phaseOf(gs: string, minute: number): Phase {
  if (/end|finish|ft|full|result|complete/i.test(gs)) return "done";
  if (minute >= 93) return "done";
  if (minute > 0 || /run|play|live|1h|2h|half/i.test(gs)) return "live";
  return "pre";
}
function liveBoard(fixtures: LiveFixture[]) {
  const S = ["home", "draw", "away"] as const;
  return fixtures.map((f) => ({ label: f.label, fixtureId: f.fixtureId, period: f.period, minute: f.minute, score: f.score, inRunning: f.inRunning, present: f.present, joint: f.jointLambda, model: S.map((s) => +f.model[s].toFixed(3)), market: f.marketX2 ? S.map((s) => +f.marketX2![s].toFixed(3)) : null, cross: f.cross.slice(0, 3).map((d) => ({ market: d.market, detail: d.detail, bp: d.residualBp })) }));
}

// Deploy the dashboard to gh-pages WITHOUT polluting master: temp-commit the (gitignored)
// state.json, push the dashboard subtree, then reset master back to pristine.
async function deploy(msg: string) {
  await sh(["add", "-f", "dashboard/state.json"]);
  await sh(["-c", "user.name=sharps", "-c", "user.email=sharps@users.noreply.github.com", "commit", "-q", "-m", msg]);
  await sh(["subtree", "push", "--prefix", "dashboard", "origin", "gh-pages"]);
  await sh(["reset", "--soft", "HEAD~1"]);
  await sh(["restore", "--staged", "dashboard/state.json"]);
}

async function main() {
  const A = loadKeypair();
  await ensureUsdtAta(A);
  console.log("tracker started:", A.publicKey.toBase58(), "poll", POLL_MS / 1000 + "s");

  const ledger = new Ledger();
  const mstate: Record<number, MState> = loadJson(MSTATE, {});
  const onchainIntents: any[] = loadJson(path.resolve("data/onchain.json"), []);
  let prev: Map<number, LiveFixture> | undefined;
  let feed: Signal[] = [];
  let engine = runEngine([{ label: "warmup", lambdaHome: 1.3, lambdaAway: 1.1 }], 1, 1000);
  let tick = 0;
  let stop = false;
  process.on("SIGINT", () => { stop = true; });
  process.on("SIGTERM", () => { stop = true; });

  while (!stop) {
    tick++;
    const now = Date.now();
    let rows;
    try { rows = await fetchRows(); } catch (e) { console.warn("fetch err", (e as Error).message); await wait(POLL_MS); continue; }

    const lt = buildTick(rows, prev, now);
    prev = new Map(lt.fixtures.map((f) => [f.fixtureId, f]));
    feed = [...lt.signals, ...feed].slice(0, 40);

    // place bets at live odds
    const minuteOf = new Map(lt.fixtures.map((f) => [f.fixtureId, f.minute]));
    for (const sig of lt.signals) {
      if (!sig.selection || !sig.oddsDecimal) continue;
      ledger.place({ agent: sig.agent, fixtureId: sig.fixtureId, label: sig.fixture, market: sig.market as any, selection: sig.selection, line: sig.line, stake: 0.02 * ledger.bankroll(sig.agent), oddsDecimal: sig.oddsDecimal, placedTs: now, entryMinute: minuteOf.get(sig.fixtureId) ?? 0, edgeBp: sig.edgeBp });
    }
    ledger.reprice(currentOddsLookup(rows)); // live CLV: re-price open bets vs the moving line

    // lifecycle backlog + collect finals
    let notable = false;
    const finals = new Map<number, [number, number]>();
    for (const { fixture, scores } of rows) {
      const sc = normalizeScores(scores, !!fixture.Participant1IsHome);
      if (!sc) continue;
      const fid = fixture.FixtureId, label = `${fixture.Participant1} v ${fixture.Participant2}`;
      const cur: MState = { phase: phaseOf(String(sc.gameState ?? ""), sc.minute), score: [sc.homeGoals, sc.awayGoals], minute: Math.round(sc.minute), gameState: String(sc.gameState ?? "") };
      const p = mstate[fid] ?? { phase: "pre", score: [0, 0], minute: 0, gameState: "" };
      if (p.phase !== "live" && cur.phase === "live") { appendEvent({ t: now, kind: "KICKOFF", fixtureId: fid, label, detail: `${cur.score[0]}-${cur.score[1]}` }); notable = true; }
      if (cur.phase === "live" && cur.score[0] + cur.score[1] > p.score[0] + p.score[1]) { appendEvent({ t: now, kind: "GOAL", fixtureId: fid, label, detail: `${cur.score[0]}-${cur.score[1]} (${cur.minute}')` }); notable = true; }
      if (p.phase === "live" && cur.phase === "done") { appendEvent({ t: now, kind: "FT", fixtureId: fid, label, detail: `${cur.score[0]}-${cur.score[1]}` }); finals.set(fid, cur.score); notable = true; }
      mstate[fid] = cur;
    }

    // settle + log settlements
    const before = (ledger as any).data.settled.length;
    const settledN = ledger.settle(finals);
    if (settledN > 0) {
      const newly = (ledger as any).data.settled.slice(before);
      for (const s of newly) appendEvent({ t: now, kind: "SETTLED", fixtureId: s.fixtureId, label: s.label, detail: `${s.agent} ${s.market} ${s.selection} ${s.result} ${s.pnl >= 0 ? "+" : ""}${Math.round(s.pnl)}u` });
      notable = true;
    }
    ledger.save();
    fs.writeFileSync(MSTATE, JSON.stringify(mstate));

    // sim backtest off live lambdas
    const specs: MatchSpec[] = lt.fixtures.map((f) => ({ label: f.label, lambdaHome: f.jointLambda[0], lambdaAway: f.jointLambda[1] }));
    if (specs.length) engine = runEngine(specs, 20, 1000);

    // occasional on-chain proof (rate-limited)
    if (onchainIntents.length < ONCHAIN_CAP && tick % ONCHAIN_EVERY === 1) {
      const c = lt.signals.filter((s) => s.agent === "cross-arb" && Math.abs(s.edgeBp) >= ONCHAIN_BP).sort((a, b) => Math.abs(b.edgeBp) - Math.abs(a.edgeBp))[0];
      const fx = c && lt.fixtures.find((f) => f.label === c.fixture);
      if (c && fx) {
        try {
          const termsHash = Array.from(crypto.createHash("sha256").update(`${c.market}:${fx.fixtureId}:${c.side}:${now}`).digest());
          const r = await postIntent(A, { intentId: now, termsHash, deposit: 1_000_000, expirationTs: Math.floor(now / 1000) + 7 * 86400, claimPeriod: 200, fixtureId: fx.fixtureId });
          onchainIntents.unshift({ ts: now, fixture: c.fixture, market: c.market, side: c.side, edgeBp: c.edgeBp, tx: r.sig });
          fs.writeFileSync(path.resolve("data/onchain.json"), JSON.stringify(onchainIntents));
          appendEvent({ t: now, kind: "ONCHAIN", fixtureId: fx.fixtureId, label: c.fixture, detail: `intent ${c.market} ${c.side} ${r.sig.slice(0, 8)}` });
          notable = true;
        } catch (e) { console.warn("intent failed", (e as Error).message?.slice(0, 60)); }
      }
    }

    const state = {
      generatedAtMs: now, track: "TxODDS World Cup — Trading Tools & Agents", ...engine,
      fixtures: liveBoard(lt.fixtures),
      live: { tick, mode: "tracker", signals: lt.signals.length, feed: feed.slice(0, 24) },
      ledger: { startBankroll: 1000, leaderboard: ledger.leaderboard(), clv: ledger.clvBoard(), open: ledger.openPositions().slice(0, 12), settled: ledger.recentSettled(10), openCount: ledger.openPositions().length },
      backlog: recentEvents(30),
      onchain: { network: "devnet", program: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J", intentTx: "2p6ub1ShSiojbqCvWcc6D2vYMDxi8NJXRSwyiSpyZsnDumLyhRuDWsJf62WkhTf1iuzaF9gq59Xj1sDUvXQ8gB46", validateTx: "neoJHaFxcmzgoicHrrvEDrfFyPFcQDoR2K9Y7Gmw7czHpkpsATN3oeToGag9BX6L5mrhCCCPy1M1oMLxvBj4R3U", liveIntents: onchainIntents.slice(0, 8) },
    };
    fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
    console.log(`tick ${tick}  fixtures=${lt.fixtures.length}  open=${ledger.openPositions().length}  settled=${(ledger as any).data.settled.length}  events=${notable ? "+" : "-"}  intents=${onchainIntents.length}`);

    if (notable || tick % HEARTBEAT === 0) { await deploy(`track: tick ${tick}`); console.log("  redeployed"); }
    if (!stop) await wait(POLL_MS);
  }
  await deploy("track: stopped");
  console.log("tracker stopped cleanly.");
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
