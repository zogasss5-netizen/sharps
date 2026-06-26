import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { loadProgram, loadKeypair, getConnection, cfg, net } from "../src/chain/client.js";

// Get test USDT from the program's devnet faucet. USDT here uses the LEGACY token program
// (per TxODDS reference fake_usdt_faucet.ts). Optional arg: wallet path (for agent B).
async function main() {
  if (net() !== "devnet") throw new Error("faucet is devnet-only.");
  const c = cfg();
  const kp = loadKeypair(process.argv[2]);
  const conn = getConnection();
  const { program } = await loadProgram(kp);

  const [faucetTracker] = PublicKey.findProgramAddressSync(
    [Buffer.from("faucet_tracker"), kp.publicKey.toBuffer()], c.programId,
  );
  const [usdtTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("usdt_treasury")], c.programId);
  const [userUsdtAta] = PublicKey.findProgramAddressSync(
    [kp.publicKey.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), c.usdtMint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  console.log("wallet:", kp.publicKey.toBase58());
  const tx = await (program as any).methods
    .requestDevnetFaucet()
    .accounts({
      user: kp.publicKey,
      faucetTracker,
      usdtMint: c.usdtMint,
      userUsdtAta,
      usdtTreasuryPda,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("faucet tx:", `https://explorer.solana.com/tx/${tx}?cluster=devnet`);

  const acct = await getAccount(conn, userUsdtAta, "confirmed", TOKEN_PROGRAM_ID);
  console.log("USDT balance:", Number(acct.amount) / 1e6, "USDT  (ata:", userUsdtAta.toBase58(), ")");
}

main().catch((e) => {
  console.error("faucet failed:", e.message ?? e);
  if (e.logs) e.logs.forEach((l: string) => console.error(l));
  process.exit(1);
});
