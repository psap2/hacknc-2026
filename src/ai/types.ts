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
  | { kind: "close_trip"; tripName: string | null; all: boolean; force: boolean }
  /** Push back on a charge; reason is their own words. */
  | { kind: "dispute"; reason: string | null }
  /** Nudge named people (or "everyone") about what they owe. */
  | { kind: "remind"; names: string[] }
  | { kind: "rename"; name: string | null }
  | { kind: "why" | "balance" | "settle" | "pay" | "help" | "undo" | "link" | "agree" }
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
}
