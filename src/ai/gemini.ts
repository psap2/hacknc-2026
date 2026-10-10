import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import type { Receipt } from "../ledger/split.js";
import { heuristicAssign, heuristicIntent } from "./heuristic.js";
import type { AI, Intent, InterpretContext, ItemAssignment } from "./types.js";

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
    kind: { type: "string", enum: ["expense", "why", "balance", "settle", "pay", "help", "unknown"] },
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
  required: ["kind", "amount_cents", "description", "split_mode", "split_names", "include_sender"],
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

  private async json<T>(parts: object[], schema: object): Promise<T> {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts }],
      config: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0 },
    });
    const text = res.text;
    if (!text) throw new Error("Gemini returned no text");
    return JSON.parse(text) as T;
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
        amount_cents: number | null;
        description: string | null;
        split_mode: "everyone" | "only" | "except" | "by_item" | "unspecified";
        split_names: string[];
        include_sender: boolean;
      }>(
        [
          {
            text: `You route text messages for Tab, a trip expense-splitting assistant.
Sender: ${ctx.senderName}
Trip members: ${ctx.memberNames.join(", ")}
The sender ${ctx.hasImage ? "ALSO attached a receipt photo (so an expense is very likely, amount may come from the photo)" : "did not attach a photo"}.

Classify the message:
- expense: the sender paid for something to split, or asks to be paid back ("pay me $30", "gas, everyone", "dinner, me jake and sam").
- why: asks why they owe / wants a breakdown.  - balance: asks what they owe or are owed.
- settle: wants to settle up.  - pay: wants to pay what they owe.  - help: asks how Tab works.  - unknown: anything else.

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
      if (out.kind !== "expense") return { kind: out.kind } as Intent;
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
