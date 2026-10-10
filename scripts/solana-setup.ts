/**
 * One-time devnet setup: treasury wallet (fee payer + mint authority), a 6-decimal
 * test USDC mint, and the master key that encrypts member wallets.
 *
 *   npm run solana:setup
 *
 * Re-running reuses whatever is already in .env.
 */
import "dotenv/config";
import { randomBytes } from "node:crypto";
import { createMint } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import bs58 from "bs58";
import { DECIMALS } from "../src/solana/devnet.js";

const rpc = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const conn = new Connection(rpc, "confirmed");

const treasury = process.env.TAB_TREASURY_SECRET
  ? Keypair.fromSecretKey(bs58.decode(process.env.TAB_TREASURY_SECRET))
  : Keypair.generate();
console.log(`Treasury: ${treasury.publicKey.toBase58()}`);

let sol = (await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL;
if (sol < 0.5) {
  console.log(`Treasury has ${sol} SOL, requesting a devnet airdrop...`);
  try {
    const sig = await conn.requestAirdrop(treasury.publicKey, 2 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
    sol = (await conn.getBalance(treasury.publicKey)) / LAMPORTS_PER_SOL;
  } catch (err) {
    console.log(`Airdrop failed (${(err as Error).message}).`);
    console.log(`Fund it manually at https://faucet.solana.com with address ${treasury.publicKey.toBase58()}, then re-run.`);
  }
}
console.log(`Treasury balance: ${sol} SOL`);

let mint = process.env.TAB_USDC_MINT;
if (!mint && sol > 0.01) {
  const pk = await createMint(conn, treasury, treasury.publicKey, null, DECIMALS);
  mint = pk.toBase58();
  console.log(`Created test USDC mint: ${mint}`);
}

console.log("\nAdd these to your .env:\n");
console.log(`SOLANA_MODE=devnet`);
console.log(`TAB_TREASURY_SECRET=${bs58.encode(treasury.secretKey)}`);
console.log(`TAB_USDC_MINT=${mint ?? "<re-run after funding the treasury>"}`);
console.log(`TAB_MASTER_KEY=${process.env.TAB_MASTER_KEY || randomBytes(32).toString("hex")}`);
