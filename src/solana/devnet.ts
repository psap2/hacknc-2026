import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { type Chain, decryptSecret, encryptSecret } from "./chain.js";

/** Our test USDC mint uses 6 decimals like real USDC: 1 cent = 10^4 base units. */
export const DECIMALS = 6;
const UNITS_PER_CENT = 10_000n;

/**
 * Real devnet implementation. The treasury wallet is mint authority for our test
 * USDC and pays every transaction fee, so members never need SOL.
 */
export class DevnetChain implements Chain {
  readonly label = "devnet";
  private conn: Connection;
  private treasury: Keypair;
  private mint: PublicKey;
  private masterKeyHex: string;

  constructor(opts: { rpcUrl: string; treasurySecret: string; mint: string; masterKeyHex: string }) {
    if (!opts.treasurySecret || !opts.mint) {
      throw new Error("SOLANA_MODE=devnet needs TAB_TREASURY_SECRET and TAB_USDC_MINT. Run `npm run solana:setup`.");
    }
    this.conn = new Connection(opts.rpcUrl, "confirmed");
    this.treasury = Keypair.fromSecretKey(bs58.decode(opts.treasurySecret));
    this.mint = new PublicKey(opts.mint);
    this.masterKeyHex = opts.masterKeyHex;
  }

  createWallet() {
    const kp = Keypair.generate();
    return { pubkey: kp.publicKey.toBase58(), encSecret: encryptSecret(kp.secretKey, this.masterKeyHex) };
  }

  private ata(owner: PublicKey) {
    return getAssociatedTokenAddressSync(this.mint, owner);
  }

  private async ensureAta(owner: PublicKey): Promise<PublicKey> {
    const ata = this.ata(owner);
    const ix = createAssociatedTokenAccountIdempotentInstruction(this.treasury.publicKey, ata, owner, this.mint);
    await sendAndConfirmTransaction(this.conn, new Transaction().add(ix), [this.treasury]);
    return ata;
  }

  async fund(pubkey: string, cents: number) {
    const ata = await this.ensureAta(new PublicKey(pubkey));
    return mintTo(this.conn, this.treasury, this.mint, ata, this.treasury, BigInt(cents) * UNITS_PER_CENT);
  }

  async balance(pubkey: string) {
    try {
      const acct = await getAccount(this.conn, this.ata(new PublicKey(pubkey)));
      return Number(acct.amount / UNITS_PER_CENT);
    } catch (err) {
      if (err instanceof TokenAccountNotFoundError) return 0;
      throw err;
    }
  }

  async transfer(fromEncSecret: string, toPubkey: string, cents: number) {
    const from = Keypair.fromSecretKey(decryptSecret(fromEncSecret, this.masterKeyHex));
    const to = new PublicKey(toPubkey);
    const toAta = this.ata(to);
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(this.treasury.publicKey, toAta, to, this.mint),
      createTransferCheckedInstruction(
        this.ata(from.publicKey),
        this.mint,
        toAta,
        from.publicKey,
        BigInt(cents) * UNITS_PER_CENT,
        DECIMALS,
      ),
    );
    tx.feePayer = this.treasury.publicKey;
    return sendAndConfirmTransaction(this.conn, tx, [this.treasury, from]);
  }

  explorerUrl(sig: string) {
    return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
  }
}
