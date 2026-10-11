import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import type { Receipt } from "../ledger/split.js";
import { heuristicAssign, heuristicChoose, heuristicIntent } from "./heuristic.js";
import type { AI, Choice, Intent, InterpretContext, ItemAssignment } from "./types.js";

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    is_receipt: { type: "boolean", description: "false if the image is not a receipt, bill or invoice" },
    merchant: { type: "string" },
    date: { type: ["string", "null"], description: "ISO date (YYYY-MM-DD) printed on the receipt, if any" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "short human-readable item name" },
          qty: { type: "integer" },
          price_cents: { type: "integer", description: "line total in cents, quantity already applied" },
        },
        required: ["name", "qty", "price_cents"],
      },
    },
    subtotal_cents: { type: "integer" },
    tax_cents: { type: "integer" },
    tip_cents: { type: "integer", description: "tip/gratuity/service charge in cents, 0 if none" },
    total_cents: { type: "integer", description: "final amount charged in cents (including tip if written)" },
  },
  required: ["is_receipt", "merchant", "items", "subtotal_cents", "tax_cents", "tip_cents", "total_cents"],
};

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["expense", "new_trip", "close_trip", "dispute", "remind", "rename", "why", "balance", "settle", "pay", "help", "undo", "link", "agree", "unknown"],
    },
    trip_name: { type: ["string", "null"], description: "For new_trip/close_trip: the destination or name, Title Case, without the word 'trip'. null if not stated." },
    all_trips: { type: "boolean", description: "For close_trip: true if the sender means every open trip ('end all my trips', 'close everything')." },
    confirmed: { type: "boolean", description: "For close_trip: true if the sender insists on closing even if money is still owed ('anyway', 'regardless', 'I know, just close it', 'don't care')." },
    settled_outside: { type: "boolean", description: "For close_trip: true if the sender says the money was already handled outside Tab ('we sorted it out', 'they paid me in person', 'already settled', 'all squared up ourselves')." },
    reason: { type: ["string", "null"], description: "For dispute: the sender's complaint in their own words." },
    people: { type: "array", items: { type: "string" }, description: "For remind: member names (exact spelling) or 'everyone'." },
    new_name: { type: ["string", "null"], description: "For rename: what the sender wants to be called." },
    amount_cents: { type: ["integer", "null"] },
    description: {
      type: ["string", "null"],
      description: "What the money was for, 1-3 words, Title Case (e.g. 'Gas', 'Dinner', 'Firewood'). null if not stated.",
    },
    split_mode: { type: "string", enum: ["everyone", "only", "except", "by_item", "unspecified"] },
    split_names: {
      type: "array",
      items: { type: "string" },
      description: "Trip member names (exact spelling from the member list) for 'only' or 'except'. Never include the sender here.",
    },
    include_sender: { type: "boolean", description: "Is the sender part of the split? Usually true." },
  },
  required: ["kind", "trip_name", "all_trips", "confirmed", "settled_outside", "reason", "people", "new_name", "amount_cents", "description", "split_mode", "split_names", "include_sender"],
};

const ASSIGN_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean", description: "false if the message doesn't say who had which items" },
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "integer", description: "1-based item number" },
          names: { type: "array", items: { type: "string" } },
        },
        required: ["item", "names"],
      },
    },
  },
  required: ["ok", "assignments"],
};

export class GeminiAI implements AI {
  private client: GoogleGenAI;

  constructor(
    apiKey: string,
    private readonly model: string,
  ) {
    this.client = new GoogleGenAI({ apiKey });
  }

  /** Free-tier quotas are per model, so when one runs dry, move down this list for the rest of the day. */
  private static readonly FALLBACKS = ["gemini-2.5-flash-lite", "gemini-2.0-flash", "gemini-2.0-flash-lite"];
  private exhausted = new Map<string, number>(); // model -> when to try it again

  private models(): string[] {
    const now = Date.now();
    const all = [this.model, ...GeminiAI.FALLBACKS.filter((m) => m !== this.model)];
    const fresh = all.filter((m) => (this.exhausted.get(m) ?? 0) <= now);
    return fresh.length ? fresh : all;
  }

  private async json<T>(parts: object[], schema: object): Promise<T> {
    let lastErr: unknown;
    for (const model of this.models()) {
      try {
        const res = await this.client.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0 },
        });
        const text = res.text;
        if (!text) throw new Error("Gemini returned no text");
        return JSON.parse(text) as T;
      } catch (err) {
        lastErr = err;
        const msg = String((err as Error)?.message ?? err);
        if (!/429|RESOURCE_EXHAUSTED|quota/i.test(msg)) throw err;
        const retry = Number(msg.match(/retry in (\d+(?:\.\d+)?)s|retryDelay":"(\d+)s/i)?.[1] ?? msg.match(/retryDelay":"(\d+)s/)?.[1] ?? 3600);
        this.exhausted.set(model, Date.now() + Math.min(retry, 24 * 3600) * 1000);
        console.warn(`[gemini] ${model} out of quota, trying the next model`);
      }
    }
    throw lastErr;
  }

  async readReceipt(image: { bytes: Buffer; mimeType: string }): Promise<Receipt | null> {
    const { bytes, mimeType } = await shrinkForVision(image);
    const out = await this.json<Receipt & { is_receipt: boolean }>(
      [
        { inlineData: { mimeType, data: bytes.toString("base64") } },
        {
          text:
            "Extract this receipt or bill. Amounts are integer cents (e.g. $12.50 -> 1250). " +
            "List each purchased line item once with its line total. Do not list tax, tip, discounts or totals as items. " +
            "If a discount applies, fold it into the affected item's price. If there are no itemized lines (e.g. a gas pump receipt), " +
            "return a single item named after what was bought.",
        },
      ],
      RECEIPT_SCHEMA,
    );
    if (!out.is_receipt || out.total_cents <= 0) return null;
    const { is_receipt: _, ...receipt } = out;
    return { ...receipt, date: receipt.date ?? null };
  }

  async interpret(text: string, ctx: InterpretContext): Promise<Intent> {
    try {
      const out = await this.json<{
        kind: Intent["kind"];
        trip_name: string | null;
        all_trips: boolean;
        confirmed: boolean;
        settled_outside: boolean;
        reason: string | null;
        people: string[];
        new_name: string | null;
        amount_cents: number | null;
        description: string | null;
        split_mode: "everyone" | "only" | "except" | "by_item" | "unspecified";
        split_names: string[];
        include_sender: boolean;
      }>(
        [
          {
            text: `You route text messages for Tab, a trip expense-splitting assistant that people talk to over iMessage.
Sender: ${ctx.senderName}
${ctx.tripName ? `Current trip: ${ctx.tripName}\nTrip members: ${ctx.memberNames.join(", ")}` : "The sender is NOT in a trip yet."}
${ctx.openTripNames.length > 1 ? `All of the sender's open trips: ${ctx.openTripNames.join(", ")}` : ""}
${ctx.openDispute ? "A friend has disputed one of the sender's charges and Tab asked the sender whether to drop it." : ""}
${ctx.ownDispute ? "The sender disputed a friend's charge earlier; it's still open." : ""}
The sender ${ctx.hasImage ? "ALSO attached a receipt photo (so an expense is very likely, amount may come from the photo)" : "did not attach a photo"}.

People text casually. Read for meaning, not keywords. Classify the message:
- new_trip: wants to start/plan a trip or tab ("i am going on a new trip to florida", "nashville next weekend, start a tab", "new trip"). trip_name = the place or name.
- close_trip: the trip is over / wants to close, end or archive it ("we're done with florida", "close the nyc tab", "end all active trips"). trip_name = which one (match the open-trip list), all_trips if they mean every trip, settled_outside if they say the money was already handled off Tab ("we sorted it out", "paid me in person"), confirmed if they insist on closing regardless.
- expense: the sender paid for something to split, or asks to be paid back ("pay me $30", "gas, everyone", "dinner, me jake and sam", "2,400 for flights").
- dispute: pushes back on a charge ("that's wrong", "I wasn't at that dinner", "I didn't order drinks"). reason = their words.
- agree: ${ctx.openDispute ? "accepts the friend's dispute (\"fine\", \"fair\", \"take her off\")" : ctx.ownDispute ? "withdraws their own dispute, is fine counting it after all (\"ok count it\", \"nevermind, I'll pay it\")" : "n/a (no open dispute) -> unknown"}.
- remind: wants Tab to nudge people who owe ("remind jake", "poke everyone"). people = names.
- rename: wants a different name ("call me PJ").
- undo: take back the last thing they logged.  - link: wants the invite link or trip page.
- why: asks why they owe / wants a breakdown.  - balance: asks what they owe or are owed, their total or running total, or where they stand.
- settle: wants to settle up.  - pay: wants to pay what they owe ("pay", "pay amit", "send ayug his money"); people = who, if named.  - help: asks how Tab works.
- unknown: chit-chat or anything Tab doesn't do. Never invent an expense from small talk.

For expenses, work out who shares it:
- "everyone", "all", "split 4 ways" -> everyone
- named people -> only (include_sender true if they say me/I/we or it's implied they were there)
- "everyone but X", "I didn't eat with X" -> except [X], unless other people are explicitly listed, then use only.
- "by item", "who had what" -> by_item
- nothing said -> unspecified.

Message: """${text}"""`,
          },
        ],
        INTENT_SCHEMA,
      );
      switch (out.kind) {
        case "new_trip":
          return { kind: "new_trip", tripName: out.trip_name?.trim() || null };
        case "close_trip":
          return { kind: "close_trip", tripName: out.trip_name?.trim() || null, all: Boolean(out.all_trips), force: Boolean(out.confirmed), settledOutside: Boolean(out.settled_outside) };
        case "dispute":
          return { kind: "dispute", reason: out.reason?.trim() || text };
        case "remind":
          return { kind: "remind", names: out.people ?? [] };
        case "rename":
          return { kind: "rename", name: out.new_name?.trim() || null };
        case "pay":
          return { kind: "pay", names: (out.people ?? []).filter((n) => !/^(me|everyone|all)$/i.test(n)) };
        case "expense":
          break;
        default:
          return { kind: out.kind } as Intent;
      }
      return {
        kind: "expense",
        amountCents: out.amount_cents,
        description: out.description,
        split: { mode: out.split_mode, names: out.split_names, includeSender: out.include_sender },
      };
    } catch (err) {
      console.warn("[gemini] interpret failed, using heuristics:", (err as Error).message);
      return heuristicIntent(text, ctx);
    }
  }

  async choose(text: string, question: string, options: Choice[], ctx: InterpretContext): Promise<string | null> {
    const keys = [...options.map((o) => o.key), "none"];
    try {
      const out = await this.json<{ choice: string }>(
        [
          {
            text: `Tab, a trip expense assistant, asked ${ctx.senderName} over text: "${question}"
What could the reply mean?
${options.map((o) => `- ${o.key}: ${o.means}`).join("\n")}
- none: the reply isn't an answer to that question (a new expense, a different request, small talk).
People answer casually ("yeah we're good", "nah leave it", "he definitely ate it"); read for meaning.

Reply: """${text}"""`,
          },
        ],
        { type: "object", properties: { choice: { type: "string", enum: keys } }, required: ["choice"] },
      );
      return out.choice === "none" ? null : out.choice;
    } catch (err) {
      console.warn("[gemini] choose failed, using heuristics:", (err as Error).message);
      return heuristicChoose(text, options);
    }
  }

  async assignItems(
    text: string,
    items: { name: string; price_cents: number }[],
    ctx: InterpretContext,
  ): Promise<ItemAssignment | null> {
    const quick = heuristicAssign(text, items.length, ctx);
    if (quick) return quick;
    try {
      const out = await this.json<{ ok: boolean; assignments: { item: number; names: string[] }[] }>(
        [
          {
            text: `Receipt items:
${items.map((it, i) => `${i + 1}. ${it.name}`).join("\n")}

Trip members: ${ctx.memberNames.join(", ")}. The sender is ${ctx.senderName} ("me"/"I" = ${ctx.senderName}).
The sender says who had what: """${text}"""

Return, for EVERY item number, the member names (exact spelling) who shared it. "rest"/"everything else" means all unmentioned items;
"everyone" means all members. If an item isn't covered, set ok=false.`,
          },
        ],
        ASSIGN_SCHEMA,
      );
      if (!out.ok) return null;
      const result = out.assignments
        .map((a) => ({ item: a.item - 1, names: a.names }))
        .filter((a) => a.item >= 0 && a.item < items.length && a.names.length);
      return new Set(result.map((a) => a.item)).size === items.length ? result : null;
    } catch (err) {
      console.warn("[gemini] assignItems failed:", (err as Error).message);
      return null;
    }
  }
}

/**
 * Phone photos are 3-12 MB; receipts read fine at ~1600px. Smaller uploads are faster
 * and avoid timeouts. Also normalizes HEIC and fixes EXIF rotation.
 */
export async function shrinkForVision(image: { bytes: Buffer; mimeType: string }): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    const bytes = await sharp(image.bytes).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
    return { bytes, mimeType: "image/jpeg" };
  } catch (err) {
    console.warn("[gemini] image resize failed, sending original:", (err as Error).message);
    return image;
  }
}
