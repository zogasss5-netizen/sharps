import "dotenv/config";
import { PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { loadProgram, loadKeypair, cfg } from "../src/chain/client.js";
import { dataBase, dataHeaders } from "../src/ingest/auth.js";

// Verify the permissionless on-chain settlement primitive: validate_stat proves a match
// stat satisfies a predicate against the oracle's posted Merkle root. Modeled on TxODDS
// reference data_validation/validate_scores_onchain.ts.

async function api(path: string) {
  const r = await fetch(`${dataBase()}${path}`, { headers: dataHeaders() });
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
}

async function main() {
  const c = cfg();
  const A = loadKeypair();
  const { program } = await loadProgram(A);

  // find a fixture that has score events (a Seq we can prove)
  const fixtures = (await api("/api/fixtures/snapshot")) as any[];
  for (const f of fixtures) {
    const fid = f.FixtureId;
    const scores = (await api(`/api/scores/snapshot/${fid}`)) as any[];
    const row = [...scores].sort((a, b) => (b.Seq ?? 0) - (a.Seq ?? 0))[0];
    if (!row?.Seq) continue;
    const statKey = 1; // goals-class stat
    let v: any;
    try { v = await api(`/api/scores/stat-validation?fixtureId=${fid}&seq=${row.Seq}&statKey=${statKey}`); }
    catch { continue; }
    if (!v?.statProof || !v?.summary || !v?.ts) continue;

    const epochDay = Math.floor(v.ts / 86400000);
    const [dailyScoresRootsPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("daily_scores_roots"), new BN(epochDay).toArrayLike(Buffer, "le", 2)], c.programId);
    const info = await program.provider.connection.getAccountInfo(dailyScoresRootsPda);
    if (!info) { console.log(`fixture ${fid} seq ${row.Seq}: no posted root for epochDay ${epochDay}, skip`); continue; }

    console.log(`Validating fixture ${fid} seq ${row.Seq} statKey ${statKey} (epochDay ${epochDay})`);
    const node = (n: any) => ({ hash: n.hash, isRightSibling: n.isRightSibling });
    const statToProve = {
      statToProve: { key: v.statToProve.key, value: v.statToProve.value, period: v.statToProve.period },
      eventStatRoot: v.eventStatRoot, statProof: v.statProof.map(node),
    };
    const fixtureSummary = {
      fixtureId: new BN(v.summary.fixtureId),
      updateStats: {
        updateCount: v.summary.updateStats.updateCount,
        minTimestamp: new BN(v.summary.updateStats.minTimestamp),
        maxTimestamp: new BN(v.summary.updateStats.maxTimestamp),
      },
      eventsSubTreeRoot: v.summary.eventStatsSubTreeRoot,
    };
    const predicate = { threshold: -1, comparison: { greaterThan: {} } }; // value > -1 → always true; tests PROOF validity
    try {
      const sig = await (program as any).methods
        .validateStat(new BN(v.ts), fixtureSummary, v.subTreeProof.map(node), v.mainTreeProof.map(node), predicate, statToProve, null, null)
        .accounts({ dailyScoresMerkleRoots: dailyScoresRootsPda })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
        .rpc();
      console.log("\nvalidate_stat OK:", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      console.log(`PROVEN on-chain: stat ${v.statToProve.key}=${v.statToProve.value} (period ${v.statToProve.period})  ✅ on-chain settlement primitive works`);
      return;
    } catch (e: any) {
      console.error("validate_stat failed:", e.message);
      if (e.logs) e.logs.slice(-10).forEach((l: string) => console.error(l));
      return;
    }
  }
  console.log("No fixture with a posted scores root found right now (oracle may not have published for current fixtures).");
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
