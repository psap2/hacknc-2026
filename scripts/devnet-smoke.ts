/**
 * End-to-end check of the real chain: two fresh wallets, fund one, transfer, print the Explorer link.
 *
 *   npx tsx scripts/devnet-smoke.ts
 */
import "dotenv/config";
import { fmt } from "../src/ledger/split.js";
import { DevnetChain } from "../src/solana/devnet.js";

const chain = new DevnetChain({
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  treasurySecret: process.env.TAB_TREASURY_SECRET ?? "",
  mint: process.env.TAB_USDC_MINT ?? "",
  masterKeyHex: process.env.TAB_MASTER_KEY ?? "",
});

const t = (label: string, started: number) => console.log(`${label} (${Date.now() - started}ms)`);

const jake = chain.createWallet();
const amit = chain.createWallet();
console.log(`Jake ${jake.pubkey}\nAmit ${amit.pubkey}`);

let s = Date.now();
await chain.fund(jake.pubkey, 500_00);
t(`funded Jake with ${fmt(500_00)}`, s);

s = Date.now();
const sig = await chain.transfer(jake.encSecret, amit.pubkey, 52_00);
t(`Jake -> Amit ${fmt(52_00)}`, s);
console.log(chain.explorerUrl(sig));

console.log(`Jake balance ${fmt(await chain.balance(jake.pubkey))}, Amit balance ${fmt(await chain.balance(amit.pubkey))}`);
