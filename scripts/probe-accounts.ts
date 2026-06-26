import "dotenv/config";
import { loadProgram } from "../src/chain/client.js";

// Enumerate existing program accounts on devnet to reverse-engineer PDA seed schemes.
async function main() {
  const { program } = await loadProgram();
  for (const name of ["tradeEscrow", "orderIntent", "matchedTrade"]) {
    try {
      const all = await (program.account as any)[name].all();
      console.log(`\n${name}: ${all.length} accounts`);
      for (const a of all.slice(0, 3)) {
        console.log("  addr:", a.publicKey.toBase58());
        const acc = a.account;
        for (const k of Object.keys(acc)) {
          const v: any = (acc as any)[k];
          console.log("    ", k, "=", v?.toBase58?.() ?? v?.toString?.() ?? JSON.stringify(v));
        }
      }
    } catch (e: any) {
      console.log(name, "err:", e.message?.slice(0, 140));
    }
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
