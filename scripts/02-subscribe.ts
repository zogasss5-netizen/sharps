import "dotenv/config";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import nacl from "tweetnacl";
import { loadProgram, loadKeypair, getConnection, cfg, net } from "../src/chain/client.js";
import { writeEnv } from "../src/util/dotenv-write.js";

// Subscribe to the free World Cup tier on devnet, then activate the API token.
// Devnet pricing matrix exposes row_id=1 at price 0 (verified on-chain) -> SERVICE_LEVEL_ID=1.
// Modeled on TxODDS reference: github.com/txodds/tx-on-chain examples/subscription/subscribe.ts

const AUTH_BASES = [
  process.env.TXLINE_BASE ?? "https://txline-dev.txodds.com",
  "https://oracle-dev.txodds.com",
  "https://txline-dev.txodds.com",
];

async function guestStart(): Promise<{ jwt: string; base: string }> {
  let lastErr: unknown;
  for (const base of AUTH_BASES) {
    try {
      const r = await fetch(`${base}/auth/guest/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!r.ok) throw new Error(`${base} -> HTTP ${r.status}`);
      const { token } = (await r.json()) as { token: string };
      if (token) return { jwt: token, base };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`guest auth failed on all bases: ${String(lastErr)}`);
}

async function main() {
  if (net() !== "devnet") throw new Error("Subscribe is devnet-only here. Mainnet = real money; flag first.");
  const c = cfg();
  const kp = loadKeypair();
  const conn = getConnection();
  const serviceLevelId = Number(process.env.SERVICE_LEVEL_ID ?? 1);
  const weeks = Number(process.env.SUBSCRIBE_WEEKS ?? 1);
  const leagues: number[] = []; // standard bundle

  const bal = await conn.getBalance(kp.publicKey);
  console.log("wallet:", kp.publicKey.toBase58(), "balance:", bal / 1e9, "SOL");
  if (bal < 0.02 * 1e9) throw new Error("Need ~0.02 devnet SOL for ATA rent + fees. Run `npm run wallet` / airdrop first.");

  const { program } = await loadProgram(kp);

  // user's TxL ATA (created if missing; free tier costs 0 tokens but the account must exist)
  const userTokenAccount = await getOrCreateAssociatedTokenAccount(
    conn, kp, c.txlMint, kp.publicKey, false, "confirmed", undefined, TOKEN_2022_PROGRAM_ID,
  );

  const [pricingMatrixPda] = PublicKey.findProgramAddressSync([Buffer.from("pricing_matrix")], c.programId);
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync([Buffer.from("token_treasury_v2")], c.programId);
  const tokenTreasuryVault = getAssociatedTokenAddressSync(c.txlMint, tokenTreasuryPda, true, TOKEN_2022_PROGRAM_ID);

  console.log(`subscribe(serviceLevelId=${serviceLevelId}, weeks=${weeks})...`);
  const txSig = await (program as any).methods
    .subscribe(serviceLevelId, weeks)
    .accounts({
      user: kp.publicKey,
      pricingMatrix: pricingMatrixPda,
      tokenMint: c.txlMint,
      userTokenAccount: userTokenAccount.address,
      tokenTreasuryVault,
      tokenTreasuryPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log("subscribed. tx:", `https://explorer.solana.com/tx/${txSig}?cluster=devnet`);

  // Activate: sign the strict binding `${txSig}:${leagues}:${jwt}` (ed25519 detached, base64).
  const { jwt, base } = await guestStart();
  const messageString = `${txSig}:${leagues.join(",")}:${jwt}`;
  const sig = nacl.sign.detached(new TextEncoder().encode(messageString), kp.secretKey);
  const walletSignature = Buffer.from(sig).toString("base64");

  const r = await fetch(`${base}/api/token/activate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ txSig, walletSignature, leagues }),
  });
  const bodyText = await r.text();
  if (!r.ok) throw new Error(`activate failed HTTP ${r.status}: ${bodyText}\nManual params -> txSig:${txSig} sig:${walletSignature}`);

  let apiToken = bodyText.trim();
  try { apiToken = JSON.parse(bodyText).token ?? apiToken; } catch { /* text/plain token */ }

  writeEnv({ GUEST_JWT: jwt, API_TOKEN: apiToken, SUBSCRIBE_TXSIG: txSig });
  console.log("\nACTIVATED ✅  (base:", base, ")");
  console.log("apiToken:", apiToken.slice(0, 16), "… written to .env (GUEST_JWT, API_TOKEN)");
}

main().catch((e) => { console.error("subscribe/activate failed:", e.message ?? e); process.exit(1); });
