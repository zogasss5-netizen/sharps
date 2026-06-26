import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { loadKeypair, getConnection } from "../src/chain/client.js";
import { postIntent, executeMatch, ensureUsdtAta, requestFaucet, usdtAta } from "../src/chain/venue.js";

// Verify the matching step: agents A and B post opposing intents (same terms_hash =
// same predicate, A=YES / B=NO), a solver pairs them via execute_match into a MatchedTrade.
const conn = getConnection();

function loadOrMake(p: string) {
  const abs = path.resolve(p);
  if (fs.existsSync(abs)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(abs, "utf8"))));
  const kp = Keypair.generate(); fs.writeFileSync(abs, JSON.stringify(Array.from(kp.secretKey))); return kp;
}
async function fundSol(from: Keypair, to: Keypair, sol: number) {
  if ((await conn.getBalance(to.publicKey)) > 0.05 * LAMPORTS_PER_SOL) return;
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports: sol * LAMPORTS_PER_SOL }));
  await sendAndConfirmTransaction(conn, tx, [from]);
}
const bal = async (ata: any) => { try { return Number((await getAccount(conn, ata, "confirmed", TOKEN_PROGRAM_ID)).amount) / 1e6; } catch { return 0; } };

async function main() {
  const A = loadKeypair();
  const B = loadOrMake(".wallet/agent-b.json");
  await fundSol(A, B, 0.3);
  await ensureUsdtAta(A); await ensureUsdtAta(B);
  for (const kp of [A, B]) if ((await bal(usdtAta(kp.publicKey))) < 2) { try { await requestFaucet(kp); } catch {} }
  console.log("A", A.publicKey.toBase58(), await bal(usdtAta(A.publicKey)), "USDT");
  console.log("B", B.publicKey.toBase58(), await bal(usdtAta(B.publicKey)), "USDT");

  // Same predicate for both sides -> same terms_hash. A backs YES, B backs NO.
  const fixtureId = 17588234;
  const termsHash = Array.from(crypto.createHash("sha256").update(`home_win:${fixtureId}`).digest());
  const exp = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;

  const idA = Date.now(), idB = Date.now() + 1;
  const ia = await postIntent(A, { intentId: idA, termsHash, deposit: 1_000_000, expirationTs: exp, claimPeriod: 200, fixtureId });
  console.log("A intent:", ia.orderIntent.toBase58());
  const ib = await postIntent(B, { intentId: idB, termsHash, deposit: 1_000_000, expirationTs: exp, claimPeriod: 200, fixtureId });
  console.log("B intent:", ib.orderIntent.toBase58());

  const tradeId = Date.now() + 2;
  try {
    const m = await executeMatch(A, {
      tradeId, makerIntent: ia.orderIntent, takerIntent: ib.orderIntent,
      makerVault: ia.intentVault, takerVault: ib.intentVault, makerStake: 1_000_000, takerStake: 1_000_000,
    });
    console.log("\nexecute_match OK:", `https://explorer.solana.com/tx/${m.sig}?cluster=devnet`);
    console.log("TRADE VAULT BALANCE:", await bal(m.tradeVault), "USDT  ✅ on-chain match works");
  } catch (e: any) {
    console.error("\nexecute_match failed:", e.message);
    // brute-force trade_vault seed against the expected address from the ConstraintSeeds log
    const logs: string[] = e.logs ?? [];
    const ri = logs.findIndex((l) => l.includes("Right:"));
    const expected = ri >= 0 ? logs[ri + 1]?.replace("Program log: ", "").trim() : null;
    if (expected) {
      const { PublicKey } = await import("@solana/web3.js");
      const { BN } = await import("@coral-xyz/anchor");
      const { cfg } = await import("../src/chain/client.js");
      const { pdas } = await import("../src/chain/venue.js");
      const pid = cfg().programId;
      const mt = pdas().matchedTrade(tradeId);
      const tle = new BN(tradeId).toArrayLike(Buffer, "le", 8);
      const parts: Record<string, Buffer> = { mt: mt.toBuffer(), id: tle, mkA: ia.orderIntent.toBuffer(), tkB: ib.orderIntent.toBuffer() };
      const prefixes = ["trade_vault", "vault", "trade", "escrow_vault"];
      const combos = (p: string) => ({
        "[p,mt]": [Buffer.from(p), parts.mt], "[p,id]": [Buffer.from(p), parts.id],
        "[mt]": [parts.mt], "[p]": [Buffer.from(p)],
        "[p,mt,id]": [Buffer.from(p), parts.mt, parts.id],
        "[p,mkA,tkB]": [Buffer.from(p), parts.mkA, parts.tkB],
      });
      let found = "";
      for (const p of prefixes) for (const [lbl, seeds] of Object.entries(combos(p))) {
        try { if (PublicKey.findProgramAddressSync(seeds as Buffer[], pid)[0].toBase58() === expected) found = `${p} | ${lbl}`; } catch {}
      }
      console.error("trade_vault expected:", expected, "-> seed scheme:", found || "NOT FOUND (widen)");
    } else if (logs.length) logs.slice(-12).forEach((l) => console.error(l));
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
