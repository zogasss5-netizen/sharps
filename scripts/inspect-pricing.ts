import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { loadProgram, cfg } from "../src/chain/client.js";
import { derivePdas } from "../src/chain/addresses.js";

// Read-only: fetch the on-chain PricingMatrix and check whether service level 12 is free.
async function main() {
  const c = cfg();
  const { program } = await loadProgram();
  const { pricingMatrixPda } = derivePdas(c.programId, c.txlMint, c.usdtMint);
  console.log("pricing_matrix PDA:", pricingMatrixPda.toBase58());

  const pm: any = await (program.account as any).pricingMatrix.fetch(pricingMatrixPda);
  console.log("admin:", pm.admin.toBase58(), "rows:", pm.rows.length);
  for (const r of pm.rows) {
    const id = Number(r.rowId);
    const price = BigInt(r.pricePerWeekToken.toString());
    console.log(
      `row ${id}: price/week=${price} TxL-base  sampling=${r.samplingIntervalSec}s  league=${r.leagueBundleId} market=${r.marketBundleId}`,
    );
  }
  const free = pm.rows.find((r: any) => Number(r.rowId) === 12);
  if (free) {
    const price = BigInt(free.pricePerWeekToken.toString());
    console.log(`\nLEVEL 12: price/week=${price} -> ${price === 0n ? "FREE ✅" : "NOT free ⚠"}`);
  } else {
    console.log("\nLEVEL 12 not present in matrix ⚠");
  }
}

main().catch((e) => {
  console.error("inspect failed:", e.message ?? e);
  process.exit(1);
});
