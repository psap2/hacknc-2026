import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";

/**
 * Money movement. Amounts are integer cents of our devnet test USDC (6 decimals on chain).
 * Wallets are custodial: Tab holds an encrypted secret key for each person (devnet only!).
 */
export interface Chain {
  readonly label: string;
  createWallet(): { pubkey: string; encSecret: string };
  /** Give a new wallet its starting test USDC. */
  fund(pubkey: string, cents: number): Promise<string | null>;
  balance(pubkey: string): Promise<number>;
  transfer(fromEncSecret: string, toPubkey: string, cents: number): Promise<string>;
  explorerUrl(sig: string): string;
}

// ---- key encryption (AES-256-GCM under TAB_MASTER_KEY)

export function encryptSecret(secret: Uint8Array, masterKeyHex: string): string {
  const key = masterKey(masterKeyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptSecret(enc: string, masterKeyHex: string): Uint8Array {
  const [iv, tag, data] = enc.split(".").map((s) => Buffer.from(s, "base64"));
  if (!iv || !tag || !data) throw new Error("malformed encrypted secret");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(masterKeyHex), iv);
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(data), decipher.final()]));
}

function masterKey(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("TAB_MASTER_KEY must be 32 bytes of hex (64 chars). Run `npm run solana:setup`.");
  return key;
}

/** In-memory fake chain for local dev and tests. Real keypairs, fake balances. */
export class MockChain implements Chain {
  readonly label = "mock";
  private balances = new Map<string, number>();
  private secrets = new Map<string, string>(); // encSecret -> pubkey
  private n = 0;

  createWallet() {
    const kp = Keypair.generate();
    const pubkey = kp.publicKey.toBase58();
    const encSecret = `mock:${pubkey}`;
    this.secrets.set(encSecret, pubkey);
    return { pubkey, encSecret };
  }
  async fund(pubkey: string, cents: number) {
    this.balances.set(pubkey, (this.balances.get(pubkey) ?? 0) + cents);
    return `mockfund${++this.n}`;
  }
  async balance(pubkey: string) {
    return this.balances.get(pubkey) ?? 0;
  }
  async transfer(fromEncSecret: string, toPubkey: string, cents: number) {
    const from = this.secrets.get(fromEncSecret) ?? fromEncSecret.replace(/^mock:/, "");
    const bal = this.balances.get(from) ?? 0;
    if (bal < cents) throw new Error(`insufficient funds: has ${bal}, needs ${cents}`);
    this.balances.set(from, bal - cents);
    this.balances.set(toPubkey, (this.balances.get(toPubkey) ?? 0) + cents);
    return `mocktx${++this.n}`;
  }
  explorerUrl(sig: string) {
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }
}
