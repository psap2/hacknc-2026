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
  | { kind: "why" | "balance" | "settle" | "pay" | "help" }
  | { kind: "unknown" };

export interface InterpretContext {
  senderName: string;
  memberNames: string[];
  hasImage: boolean;
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
