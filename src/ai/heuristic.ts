import type { Receipt } from "../ledger/split.js";
import { parseCents } from "../ledger/split.js";
import type { AI, Intent, InterpretContext, ItemAssignment, SplitSpec } from "./types.js";

const EVERYONE = /\b(everyone|everybody|all of us|all|evenly|equally|split \d+ ways|\d+ ways|whole group)\b/i;
const BY_ITEM = /\b(by item|itemi[sz]e|per item|who had what|each item)\b/i;
const NEGATION = /\b(except|but not|without|not|didn'?t|did not|wasn'?t|minus|excluding|but)\b/i;
const ME = /\b(me|i|we|myself)\b/i;

function mentioned(text: string, names: string[]): string[] {
  const lower = text.toLowerCase();
  return names.filter((n) => new RegExp(`\\b${escape(n.toLowerCase())}\\b`).test(lower));
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-effort split parsing without an LLM. Good enough for demos and tests. */
export function heuristicSplit(text: string, ctx: InterpretContext): SplitSpec {
  const others = ctx.memberNames.filter((n) => n.toLowerCase() !== ctx.senderName.toLowerCase());
  if (BY_ITEM.test(text)) return { mode: "by_item", names: [], includeSender: true };

  const neg = text.match(NEGATION);
  if (neg && neg.index !== undefined) {
    const after = text.slice(neg.index);
    const excluded = mentioned(after, others);
    if (excluded.length) {
      const before = text.slice(0, neg.index);
      const included = mentioned(before, others).filter((n) => !excluded.includes(n));
      if (included.length) return { mode: "only", names: included, includeSender: true };
      return { mode: "except", names: excluded, includeSender: true };
    }
  }

  const named = mentioned(text, others);
  if (named.length) return { mode: "only", names: named, includeSender: ME.test(text) || /\bwith\b/i.test(text) };
  if (EVERYONE.test(text)) return { mode: "everyone", names: [], includeSender: true };
  return { mode: "unspecified", names: [], includeSender: true };
}

export function heuristicAmount(text: string): number | null {
  const m = text.match(/\$\s*(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*\.\d{2})\b|\b(\d+)\b(?!\s*ways)/);
  if (!m) return null;
  return parseCents(m[1] ?? m[2] ?? m[3]!);
}

export function heuristicDescription(text: string, memberNames: string[]): string | null {
  let s = text.split(/[,.;!\n]/)[0] ?? "";
  s = s
    .replace(/\$?\s*\d[\d,]*(?:\.\d{1,2})?/g, " ")
    .replace(/\b(i|we|paid|pay|me|you|for|on|the|a|an|spent|bought|got|owe|split|it|this|is|was|total|everyone|evenly|ways|with|and)\b/gi, " ");
  for (const n of memberNames) s = s.replace(new RegExp(`\\b${escape(n)}\\b`, "gi"), " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function heuristicIntent(text: string, ctx: InterpretContext): Intent {
  const t = text.trim();
  if (/\bwhy\b|how much do i owe|breakdown/i.test(t)) return { kind: "why" };
  if (/^(balance|balances|what do i owe|status)\b/i.test(t)) return { kind: "balance" };
  const amountCents = heuristicAmount(t);
  if (amountCents !== null || ctx.hasImage) {
    return {
      kind: "expense",
      amountCents,
      description: heuristicDescription(t, ctx.memberNames),
      split: heuristicSplit(t, ctx),
    };
  }
  return { kind: "unknown" };
}

/**
 * Parses things like "1,3 Sam; 2 Jo; rest everyone" or "sam 1 3, jo 2, rest split".
 * Returns null when it can't make sense of it.
 */
export function heuristicAssign(
  text: string,
  itemCount: number,
  ctx: InterpretContext,
): ItemAssignment | null {
  const everyone = ctx.memberNames;
  const out = new Map<number, Set<string>>();
  let restNames: string[] | null = null;

  for (const seg of text.split(/[;\n]|,\s+(?=[a-z])/i).map((s) => s.trim()).filter(Boolean)) {
    let names = mentioned(seg, everyone);
    if (ME.test(seg) && !names.includes(ctx.senderName)) names.push(ctx.senderName);
    if (EVERYONE.test(seg) || /\bsplit\b/i.test(seg)) names = everyone;
    if (!names.length) continue;
    if (/\b(rest|others|everything else|remaining)\b/i.test(seg)) {
      restNames = names;
      continue;
    }
    const nums = [...seg.matchAll(/\b(\d+)\b/g)].map((m) => Number(m[1]) - 1).filter((i) => i >= 0 && i < itemCount);
    if (!nums.length) continue;
    for (const i of nums) {
      const set = out.get(i) ?? new Set<string>();
      names.forEach((n) => set.add(n));
      out.set(i, set);
    }
  }
  if (restNames) for (let i = 0; i < itemCount; i++) if (!out.has(i)) out.set(i, new Set(restNames));
  if (out.size !== itemCount) return null;
  return [...out].sort((a, b) => a[0] - b[0]).map(([item, set]) => ({ item, names: [...set] }));
}

/** AI implementation with no model: used when GEMINI_API_KEY is missing, and in tests. */
export class HeuristicAI implements AI {
  async readReceipt(): Promise<Receipt | null> {
    return null;
  }
  async interpret(text: string, ctx: InterpretContext): Promise<Intent> {
    return heuristicIntent(text, ctx);
  }
  async assignItems(text: string, items: { name: string }[], ctx: InterpretContext) {
    return heuristicAssign(text, items.length, ctx);
  }
}
