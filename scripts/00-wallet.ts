import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getConnection, net } from "../src/chain/client.js";

// Generate (or load) a devnet wallet and make sure it has some SOL for gas.
async function main() {
  if (net() !== "devnet") throw new Error("00-wallet is devnet only.");
  const p = path.resolve(process.env.WALLET_PATH ?? ".wallet/devnet.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });

  let kp: Keypair;
  if (fs.existsSync(p)) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
    console.log("loaded existing wallet:", kp.publicKey.toBase58());
  } else {
    kp = Keypair.generate();
    fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
    console.log("generated wallet:", kp.publicKey.toBase58(), "->", p);
  }

  const conn = getConnection();
  let bal = await conn.getBalance(kp.publicKey);
  console.log("balance:", bal / LAMPORTS_PER_SOL, "SOL");

  if (bal < 0.5 * LAMPORTS_PER_SOL) {
    console.log("requesting devnet airdrop (1 SOL)...");
    try {
      const sig = await conn.requestAirdrop(kp.publicKey, 1 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      bal = await conn.getBalance(kp.publicKey);
      console.log("airdrop OK. balance:", bal / LAMPORTS_PER_SOL, "SOL");
    } catch (e) {
      console.warn("airdrop failed (devnet faucet rate limit is common):", (e as Error).message);
      console.warn("fallback: `solana airdrop 1 <pubkey> --url devnet` or https://faucet.solana.com");
    }
  }
  console.log("\nPUBKEY:", kp.publicKey.toBase58());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
