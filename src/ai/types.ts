import type { Receipt } from "../ledger/split.js";

export interface SplitSpec {
  /**
   * everyone    – all trip members
   * only        – just `names` (+ sender if includeSender)
   * except      – everyone minus `names`
   * by_item     – payer wants to assign receipt items
   * unspecified – nothing said; ask
   */
  mode: "everyone" | "only" | "except" | "by_item" | "unspecified";
  names: string[];
  includeSender: boolean;
}

export type Intent =
  | { kind: "expense"; amountCents: number | null; description: string | null; split: SplitSpec }
  /** Start a trip. tripName null = they want one but didn't say what to call it. */
  | { kind: "new_trip"; tripName: string | null }
  /** Close/finish a trip; tripName null = whichever one they're in. */
  /** force = insists despite open balances; settledOutside = says the money already changed hands off Tab. */
  | { kind: "close_trip"; tripName: string | null; all: boolean; force: boolean; settledOutside: boolean }
  /** Push back on a charge; reason is their own words. */
  | { kind: "dispute"; reason: string | null }
  /** Nudge named people (or "everyone") about what they owe. */
  | { kind: "remind"; names: string[] }
  | { kind: "rename"; name: string | null }
  /** Pay what they owe; names = only these people, if they said who ("pay amit"). */
  | { kind: "pay"; names: string[] }
  | { kind: "why" | "balance" | "settle" | "help" | "undo" | "link" | "agree" }
  | { kind: "unknown" };

export interface InterpretContext {
  senderName: string;
  memberNames: string[];
  hasImage: boolean;
  /** Active trip name, or null when the sender isn't in a trip yet. */
  tripName: string | null;
  /** Every open trip the sender is in (so "close the beach one" / "end all trips" can be resolved). */
  openTripNames: string[];
  /** Someone disputed one of the sender's charges and it's still open. */
  openDispute: boolean;
  /** The sender disputed someone else's charge and it's still open (so "fine, count it" withdraws it). */
  ownDispute: boolean;
}

/** One possible meaning of a reply to a question Tab asked. `hints` is only for the no-model fallback. */
export interface Choice {
  key: string;
  means: string;
  hints?: RegExp;
}

/** item index (0-based) -> names who shared it. */
export type ItemAssignment = { item: number; names: string[] }[];

/** The only things Tab asks an LLM to do. It never does money math. */
export interface AI {
  readReceipt(image: { bytes: Buffer; mimeType: string }): Promise<Receipt | null>;
  interpret(text: string, ctx: InterpretContext): Promise<Intent>;
  assignItems(
    text: string,
    items: { name: string; price_cents: number }[],
    ctx: InterpretContext,
  ): Promise<ItemAssignment | null>;
  /**
   * Tab asked a question; which option does the reply mean? null = the message isn't an answer
   * (a new expense, something unrelated), so it should be handled as a fresh message.
   */
  choose(text: string, question: string, options: Choice[], ctx: InterpretContext): Promise<string | null>;
}
