import type { Receipt } from "../ledger/split.js";
import { parseCents } from "../ledger/split.js";
import type { AI, Choice, Intent, InterpretContext, ItemAssignment, SplitSpec } from "./types.js";

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
  const k = text.match(/\$?\s*(\d+(?:\.\d+)?)\s*k\b/i);
  if (k) return Math.round(Number(k[1]) * 1000) * 100;
  const m = text.match(
    /\$\s*(\d[\d,]*(?:\.\d{1,2})?)|\b(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?)\b|\b(\d[\d,]*\.\d{2})\b|\b(\d+)\b(?!\s*(?:ways|people|of us|items?|nights?|days?|pm|am))/,
  );
  if (!m) return null;
  return parseCents(m[1] ?? m[2] ?? m[3] ?? m[4]!);
}

export function heuristicDescription(text: string, memberNames: string[]): string | null {
  // Strip money first so the comma in "2,400" or the dot in "12.50" doesn't end the sentence early.
  const noMoney = text.replace(/\$?\s*\d+(?:\.\d+)?\s*k\b/gi, " ").replace(/\$?\s*\d[\d,]*(?:\.\d{1,2})?/g, " ");
  let s = noMoney.split(/[,.;!\n]/)[0] ?? "";
  s = s
    .replace(/\b(i|we|paid|pay|me|you|for|on|the|a|an|spent|bought|got|owe|split|it|this|is|was|total|everyone|evenly|ways|with|and|actually|also|just|oh|ok|okay)\b/gi, " ");
  for (const n of memberNames) s = s.replace(new RegExp(`\\b${escape(n)}\\b`, "gi"), " ");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "going on a trip to Florida", "planning a Nashville trip next month", "trip to nepal" -> trip name. */
export function heuristicTripName(text: string): string | null | undefined {
  const t = text.trim();
  if (!/\b(trip|tab|vacation|getaway)\b/i.test(t)) return undefined;
  const stop = "(?:\\s+(?:next|this|in|on|with|and|for|from|,).*)?[.!?\\s]*$";
  const m =
    t.match(new RegExp(`\\b(?:trip|tab|vacation|getaway)\\s+(?:to|for|in)\\s+([A-Za-z][\\w' -]{1,30}?)${stop}`, "i")) ??
    t.match(/\b(?:new|another|next|a|our|the|my)\s+(?:new\s+)?([A-Za-z][\w' -]{1,30}?)\s+(?:trip|tab|vacation|getaway)\b/i);
  const name = m?.[1]?.trim();
  if (name && !/^(new|another|next|a|our|the|my|this|that)$/i.test(name)) return name;
  if (/\b(new|another|next|planning|going|start|create|open|make)\b/i.test(t)) return null;
  return undefined;
}

export function heuristicIntent(text: string, ctx: InterpretContext): Intent {
  const t = text.trim();
  if (/\bwhy\b|how much do i owe|breakdown/i.test(t)) return { kind: "why" };
  if (/^(balance|balances|total|totals|what do i owe|status)\b|\b(my|running) total\b|where do i stand/i.test(t)) return { kind: "balance" };
  if (/^(undo|take that back|delete that|remove that|scratch that|cancel that)\b/i.test(t)) return { kind: "undo" };
  if (/^(settle( up)?|let'?s settle|settle it)[.!]*$/i.test(t)) return { kind: "settle" };
  const pay = t.match(/^(?:pay|send)\s*(?:back\s+)?(?!me\b)([a-z][a-z' ,&]*?)?(?:\s+(?:back|his money|her money|their money|what i owe))?[.!]*$/i);
  if (pay && heuristicAmount(t) === null) return { kind: "pay", names: (pay[1] ?? "").split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean) };
  // The trip name may already have been stripped by the router ("we're done with nyc" -> "we're done with").
  const close =
    t.match(/^(?:we'?re |i'?m )?(?:all )?done with\s*(?:the\s+)?(.*?)(?:\s+(?:trips?|tabs?))?\s*(?:anyways?|regardless)?[.!]*$/i) ??
    t.match(/\b(?:close|end|finish|archive|wrap up|shut down)\s+(?:the\s+|my\s+|our\s+)?(?:(.+?)\s+)?(?:trips?|tabs?)\b/i) ??
    // "you can close out", "wrap it up", "close this out" (trip name may already be stripped)
    t.match(/\b(?:close|wrap|finish)\s+(?:it|this|that|things)?\s*(?:out|up)\b()/i);
  if (close) {
    const what = close[1]?.trim() ?? "";
    const all = /\b(all|every|everything|both)\b/i.test(what);
    return {
      kind: "close_trip",
      tripName: all ? null : what.replace(/\b(active|open|current)\b/gi, "").trim() || null,
      all,
      force: /\b(anyways?|regardless|don'?t care|whatever)\b/i.test(t),
      settledOutside: /\b(sorted|settled|squared|paid|handled|took care of)\b.*\b(out|up|already|ourselves|in person|cash|venmo|outside)\b|\balready (paid|settled)\b/i.test(t),
    };
  }
  if (/\b(invite|trip) (link|page)\b|send (me )?the link\b/i.test(t)) return { kind: "link" };
  const remind = t.match(/\b(?:remind|nudge|poke|bug)\s+(.+?)[.!?]*$/i);
  if (remind) return { kind: "remind", names: remind[1]!.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean) };
  if (/\b(dispute|that'?s (wrong|not right)|not mine|wasn'?t (me|there))\b/i.test(t)) return { kind: "dispute", reason: t };
  if ((ctx.openDispute || ctx.ownDispute) && /^(agree|agreed|fine|fair( enough)?|ok(ay)?|sure|yeah|yes|you'?re right|count it)\b/i.test(t)) return { kind: "agree" };
  const amountCents = heuristicAmount(t);
  if (amountCents === null && !ctx.hasImage) {
    const tripName = heuristicTripName(t);
    if (tripName !== undefined) return { kind: "new_trip", tripName };
    // "I didn't go to that dinner" with no amount and no photo is a complaint, not a new expense.
    if (/\bi (didn'?t|did not|never|wasn'?t)\b/i.test(t)) return { kind: "dispute", reason: t };
  }
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

export function heuristicChoose(text: string, options: Choice[]): string | null {
  const t = text.trim();
  if (!t) return null;
  return options.find((o) => o.hints?.test(t))?.key ?? null;
}

/** AI implementation with no model: used when GEMINI_API_KEY is missing, and in tests. */
export class HeuristicAI implements AI {
  async choose(text: string, _question: string, options: Choice[]): Promise<string | null> {
    return heuristicChoose(text, options);
  }
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
