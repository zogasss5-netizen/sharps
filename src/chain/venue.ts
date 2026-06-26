import { PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { loadProgram, getConnection, cfg } from "./client.js";

// The agents' interface to the txoracle on-chain venue (devnet). USDT = legacy SPL token.
// Seeds reverse-engineered (see data/CHAIN.md).

const u64le = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);

export function pdas() {
  const c = cfg();
  const pid = c.programId;
  return {
    usdtTreasury: PublicKey.findProgramAddressSync([Buffer.from("usdt_treasury")], pid)[0],
    faucetTracker: (user: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("faucet_tracker"), user.toBuffer()], pid)[0],
    orderIntent: (maker: PublicKey, intentId: number | BN) =>
      PublicKey.findProgramAddressSync([Buffer.from("intent"), maker.toBuffer(), u64le(intentId)], pid)[0],
    intentVault: (orderIntent: PublicKey) =>
      PublicKey.findProgramAddressSync([Buffer.from("intent_vault"), orderIntent.toBuffer()], pid)[0],
    matchedTrade: (tradeId: number | BN) =>
      PublicKey.findProgramAddressSync([Buffer.from("trade"), u64le(tradeId)], pid)[0],
    tradeVault: (tradeId: number | BN) =>
      PublicKey.findProgramAddressSync([Buffer.from("trade_vault"), u64le(tradeId)], pid)[0],
  };
}

export function usdtAta(owner: PublicKey) {
  return getAssociatedTokenAddressSync(cfg().usdtMint, owner, true, TOKEN_PROGRAM_ID);
}

export async function ensureUsdtAta(kp: Keypair) {
  return (await getOrCreateAssociatedTokenAccount(
    getConnection(), kp, cfg().usdtMint, kp.publicKey, false, "confirmed", undefined, TOKEN_PROGRAM_ID,
  )).address;
}

export async function requestFaucet(kp: Keypair) {
  const c = cfg();
  const { program } = await loadProgram(kp);
  const p = pdas();
  return (program as any).methods.requestDevnetFaucet().accounts({
    user: kp.publicKey, faucetTracker: p.faucetTracker(kp.publicKey), usdtMint: c.usdtMint,
    userUsdtAta: usdtAta(kp.publicKey), usdtTreasuryPda: p.usdtTreasury,
    tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }).rpc();
}

export interface IntentArgs {
  intentId: number | BN;
  termsHash: number[]; // 32 bytes
  deposit: number | BN; // USDT base units (1e6 = 1 USDT)
  expirationTs: number | BN; // unix seconds
  claimPeriod: number;
  fixtureId: number | BN;
}

/** Agent posts an OrderIntent, locking USDT in its intent vault. */
export async function postIntent(maker: Keypair, a: IntentArgs) {
  const c = cfg();
  const { program } = await loadProgram(maker);
  const p = pdas();
  const orderIntent = p.orderIntent(maker.publicKey, a.intentId);
  const intentVault = p.intentVault(orderIntent);
  const sig = await (program as any).methods
    .createIntent(new BN(a.intentId), a.termsHash, new BN(a.deposit), new BN(a.expirationTs), a.claimPeriod, new BN(a.fixtureId))
    .accounts({
      maker: maker.publicKey, orderIntent, intentVault, makerTokenAccount: usdtAta(maker.publicKey),
      tokenMint: c.usdtMint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
  return { sig, orderIntent, intentVault };
}

/** A solver pairs two opposing intents into a settled-escrow MatchedTrade. */
export async function executeMatch(
  solver: Keypair,
  args: { tradeId: number | BN; makerIntent: PublicKey; takerIntent: PublicKey; makerVault: PublicKey; takerVault: PublicKey; makerStake: number | BN; takerStake: number | BN },
) {
  const c = cfg();
  const { program } = await loadProgram(solver);
  const p = pdas();
  const matchedTrade = p.matchedTrade(args.tradeId);
  const tradeVault = p.tradeVault(args.tradeId);
  const sig = await (program as any).methods
    .executeMatch(new BN(args.tradeId), new BN(args.makerStake), new BN(args.takerStake))
    .accounts({
      solver: solver.publicKey, makerIntent: args.makerIntent, takerIntent: args.takerIntent,
      makerVault: args.makerVault, takerVault: args.takerVault, matchedTrade, tradeVault,
      tokenMint: c.usdtMint, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
  return { sig, matchedTrade, tradeVault };
}
