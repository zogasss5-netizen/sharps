import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { PublicKey, SystemProgram, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount, getAccount,
} from "@solana/spl-token";
import { loadProgram, loadKeypair, getConnection, cfg } from "../src/chain/client.js";

// Empirically confirm the on-chain trade lifecycle: two agents (A,B) stake USDT into
// create_trade escrow. Seeds reverse-engineered from the program binary:
//   trade_escrow = ["escrow", u64le(tradeId)]   (literal "escrow" in binary)
//   escrow_vault = ["escrow_vault", u64le(tradeId)]  (PDA token account, no ATA program in ix)
// On a seed mismatch Anchor logs the expected address, which we read and adjust.

const u64le = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);

async function ensureFunded(b: Keypair, a: Keypair) {
  const conn = getConnection();
  if ((await conn.getBalance(b.publicKey)) < 0.1 * LAMPORTS_PER_SOL) {
    const { SystemProgram: SP, Transaction, sendAndConfirmTransaction } = await import("@solana/web3.js");
    const tx = new Transaction().add(SP.transfer({ fromPubkey: a.publicKey, toPubkey: b.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL }));
    await sendAndConfirmTransaction(conn, tx, [a]);
    console.log("  funded B with 0.3 SOL");
  }
}

async function faucetUsdt(kp: Keypair) {
  const c = cfg();
  const { program } = await loadProgram(kp);
  const [faucetTracker] = PublicKey.findProgramAddressSync([Buffer.from("faucet_tracker"), kp.publicKey.toBuffer()], c.programId);
  const [usdtTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("usdt_treasury")], c.programId);
  const userUsdtAta = getAssociatedTokenAddressSync(c.usdtMint, kp.publicKey, false, TOKEN_PROGRAM_ID);
  try {
    await (program as any).methods.requestDevnetFaucet().accounts({
      user: kp.publicKey, faucetTracker, usdtMint: c.usdtMint, userUsdtAta, usdtTreasuryPda,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
  } catch (e: any) { console.log("  (B faucet:", e.message?.slice(0, 60), ")"); }
  return userUsdtAta;
}

async function main() {
  const c = cfg();
  const conn = getConnection();
  const A = loadKeypair();

  // agent B
  const bPath = path.resolve(".wallet/agent-b.json");
  let B: Keypair;
  if (fs.existsSync(bPath)) B = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(bPath, "utf8"))));
  else { B = Keypair.generate(); fs.writeFileSync(bPath, JSON.stringify(Array.from(B.secretKey))); }
  console.log("A:", A.publicKey.toBase58(), "\nB:", B.publicKey.toBase58());

  await ensureFunded(B, A);
  const aAta = (await getOrCreateAssociatedTokenAccount(conn, A, c.usdtMint, A.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID)).address;
  const bAta = await faucetUsdt(B);

  const { program } = await loadProgram(A);
  const tradeId = Date.now();
  const [tradeEscrow] = PublicKey.findProgramAddressSync([Buffer.from("escrow"), u64le(tradeId)], c.programId);
  const [escrowVault] = PublicKey.findProgramAddressSync([Buffer.from("escrow_vault"), u64le(tradeId)], c.programId);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("usdt_treasury")], c.programId);
  const termsHash = Array.from(new Uint8Array(32)); // placeholder bet terms

  console.log("tradeId:", tradeId, "\ntrade_escrow:", tradeEscrow.toBase58(), "\nescrow_vault:", escrowVault.toBase58());

  try {
    const tx = await (program as any).methods
      .createTrade(new BN(tradeId), new BN(1_000_000), new BN(1_000_000), termsHash)
      .accounts({
        authority: A.publicKey, traderA: A.publicKey, traderB: B.publicKey,
        traderATokenAccount: aAta, traderBTokenAccount: bAta,
        tradeEscrow, escrowVault, stakeTokenMint: c.usdtMint,
        tokenTreasuryPda, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .signers([B])
      .rpc();
    console.log("\ncreate_trade OK:", `https://explorer.solana.com/tx/${tx}?cluster=devnet`);
    const vault = await getAccount(conn, escrowVault, "confirmed", TOKEN_PROGRAM_ID);
    console.log("ESCROW VAULT BALANCE:", Number(vault.amount) / 1e6, "USDT  ✅ on-chain escrow works");
  } catch (e: any) {
    console.error("\ncreate_trade failed:", e.message);
    if (e.logs) { console.error("--- logs ---"); e.logs.forEach((l: string) => console.error(l)); }
  }
}
main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
