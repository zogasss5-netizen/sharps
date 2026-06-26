import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { loadProgram, loadKeypair, getConnection, cfg } from "../src/chain/client.js";

// Permissionless path: an agent posts an OrderIntent (locks USDT for a fixture).
// Seeds from the program binary: order_intent=["intent",u64le(id)], intent_vault=["intent_vault",u64le(id)].
const u64le = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);

async function main() {
  const c = cfg();
  const conn = getConnection();
  const A = loadKeypair();
  const { program } = await loadProgram(A);

  const intentId = Date.now();
  const [orderIntent] = PublicKey.findProgramAddressSync([Buffer.from("intent"), A.publicKey.toBuffer(), u64le(intentId)], c.programId);
  const [intentVault] = PublicKey.findProgramAddressSync([Buffer.from("intent_vault"), orderIntent.toBuffer()], c.programId);
  const makerAta = getAssociatedTokenAddressSync(c.usdtMint, A.publicKey, false, TOKEN_PROGRAM_ID);

  const deposit = new BN(1_000_000); // 1 USDT
  const expirationTs = new BN(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  const claimPeriod = 200;
  const fixtureId = new BN(17588234); // Norway v France (real WC fixture)
  const termsHash = Array.from(new Uint8Array(32));

  console.log("maker:", A.publicKey.toBase58(), "\nintentId:", intentId, "\norder_intent:", orderIntent.toBase58());

  try {
    const tx = await (program as any).methods
      .createIntent(new BN(intentId), termsHash, deposit, expirationTs, claimPeriod, fixtureId)
      .accounts({
        maker: A.publicKey, orderIntent, intentVault, makerTokenAccount: makerAta,
        tokenMint: c.usdtMint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .rpc();
    console.log("\ncreate_intent OK:", `https://explorer.solana.com/tx/${tx}?cluster=devnet`);
    const vault = await getAccount(conn, intentVault, "confirmed", TOKEN_PROGRAM_ID);
    console.log("INTENT VAULT BALANCE:", Number(vault.amount) / 1e6, "USDT  ✅ permissionless on-chain escrow works");
    const oi: any = await (program.account as any).orderIntent.fetch(orderIntent);
    console.log("OrderIntent:", { maker: oi.maker.toBase58(), deposit: oi.depositAmount.toString(), remaining: oi.remainingAmount.toString(), fixture: oi.fixtureId.toString(), state: oi.state });
  } catch (e: any) {
    console.error("\ncreate_intent failed:", e.message);
    if (e.logs) { console.error("--- logs ---"); e.logs.slice(-12).forEach((l: string) => console.error(l)); }
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
