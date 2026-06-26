import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

// Ground-truth addresses from TxODDS docs (data/addresses.md). Devnet only for now.
// NEVER use the mainnet block without an explicit go-ahead (real money).

export const DEVNET = {
  programId: new PublicKey("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J"),
  txlMint: new PublicKey("4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG"),
  usdtMint: new PublicKey("ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh"),
  apiBase: "https://txline-dev.txodds.com",
} as const;

export const MAINNET = {
  programId: new PublicKey("9ExbZjAapQww1vfcisDmrngPinHTEfpjYRWMunJgcKaA"),
  txlMint: new PublicKey("Zhw9TVKp68a1QrftncMSd6ELXKDtpVMNuMGr1jNwdeL"),
  usdtMint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"),
  apiBase: "https://txline.txodds.com",
} as const;

// Mints use the Token-2022 program.
export const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;

/** Derive the program PDAs we need. Seeds per data/addresses.md. */
export function derivePdas(programId: PublicKey, txlMint: PublicKey, usdtMint: PublicKey) {
  const [tokenTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_treasury_v2")],
    programId,
  );
  const tokenTreasuryVault = getAssociatedTokenAddressSync(
    txlMint,
    tokenTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  const [pricingMatrixPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("pricing_matrix")],
    programId,
  );
  const [usdtTreasuryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("usdt_treasury")],
    programId,
  );
  const usdtTreasuryVault = getAssociatedTokenAddressSync(
    usdtMint,
    usdtTreasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  return { tokenTreasuryPda, tokenTreasuryVault, pricingMatrixPda, usdtTreasuryPda, usdtTreasuryVault };
}
