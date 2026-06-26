import fs from "node:fs";
import path from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import { DEVNET, MAINNET } from "./addresses.js";

export type Net = "devnet" | "mainnet";

export function net(): Net {
  return (process.env.NETWORK as Net) ?? "devnet";
}

export function cfg() {
  const n = net();
  if (n === "mainnet") {
    throw new Error("Refusing mainnet: real money. Set NETWORK=mainnet deliberately to override.");
  }
  return DEVNET;
}

/** Unsafe escape hatch, only after an explicit go-ahead. */
export function cfgRaw() {
  return net() === "mainnet" ? MAINNET : DEVNET;
}

export function getConnection(): Connection {
  const rpc = process.env.SOLANA_RPC ?? "https://api.devnet.solana.com";
  return new Connection(rpc, "confirmed");
}

export function loadKeypair(p = process.env.WALLET_PATH ?? ".wallet/devnet.json"): Keypair {
  const abs = path.resolve(p);
  const raw = JSON.parse(fs.readFileSync(abs, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Anchor program bound to the txoracle IDL + our wallet. */
export async function loadProgram(kp = loadKeypair()) {
  const idl = JSON.parse(
    fs.readFileSync(path.resolve("src/chain/idl.devnet.json"), "utf8"),
  );
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(getConnection(), wallet, {
    commitment: "confirmed",
  });
  // anchor >=0.30: program id is read from idl.address
  const program = new anchor.Program(idl, provider);
  return { program, provider, wallet };
}

export const PROGRAM_ID = (): PublicKey => cfg().programId;
