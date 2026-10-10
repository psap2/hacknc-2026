import { beforeEach, describe, expect, it } from "vitest";
import { Tab } from "../src/agent/bot.js";
import { HeuristicAI } from "../src/ai/heuristic.js";
import { openDb, Store } from "../src/ledger/db.js";
import type { Receipt } from "../src/ledger/split.js";
import type { Inbound, InboundHandler, Messenger } from "../src/messaging/types.js";
import { MockChain } from "../src/solana/chain.js";

/** Records every outbound text per phone. */
class FakeMessenger implements Messenger {
  inbox = new Map<string, string[]>();
  async start(_: InboundHandler) {}
  async send(phone: string, text: string) {
    this.inbox.set(phone, [...(this.inbox.get(phone) ?? []), text]);
  }
  async register() {}
  async stop() {}
  last(phone: string) {
    return this.inbox.get(phone)?.at(-1) ?? "";
  }
  all(phone: string) {
    return this.inbox.get(phone) ?? [];
  }
  clear() {
    this.inbox.clear();
  }
}

/** Heuristic text parsing + a queue of fake receipt OCR results. */
class StubAI extends HeuristicAI {
  receipts: Receipt[] = [];
  override async readReceipt() {
    return this.receipts.shift() ?? null;
  }
}

const receipt = (merchant: string, items: [string, number][], tax = 0, tip = 0): Receipt => {
  const subtotal = items.reduce((a, [, c]) => a + c, 0);
  return {
    merchant,
    date: null,
    items: items.map(([name, price_cents]) => ({ name, qty: 1, price_cents })),
    subtotal_cents: subtotal,
    tax_cents: tax,
    tip_cents: tip,
    total_cents: subtotal + tax + tip,
  };
};

const PHOTO = { bytes: Buffer.from("fake"), mimeType: "image/jpeg" };
const AMIT = "+15550000001";
const JAKE = "+15550000002";
const PRIYA = "+15550000003";
const SAM = "+15550000004";

describe("the Asheville trip", () => {
  let now: number;
  let m: FakeMessenger;
  let ai: StubAI;
  let chain: MockChain;
  let store: Store;
  let bot: Tab;
  const say = (phone: string, text: string, images: Inbound["images"] = []) => bot.handle({ phone, text, images });

  beforeEach(() => {
    now = Date.parse("2026-10-11T12:00:00Z");
    m = new FakeMessenger();
    ai = new StubAI();
    chain = new MockChain();
    store = new Store(openDb(":memory:"));
    bot = new Tab({
      store,
      messenger: m,
      ai,
      chain,
      now: () => now,
      config: {
        botName: "Tab",
        publicUrl: "https://tab.test",
        botPhone: "",
        startingBalanceCents: 50000,
        autoApproveMs: 48 * 3600_000,
        reminderGapMs: 24 * 3600_000,
      },
    });
  });

  async function setupTrip() {
    await say(AMIT, "new trip Asheville");
    const invite = m.all(AMIT).join("\n");
    const code = invite.match(/\/j\/([A-Z0-9]+)/)![1]!;
    await say(AMIT, "Amit");
    for (const [phone, name] of [
      [JAKE, "Jake"],
      [PRIYA, "Priya"],
      [SAM, "Sam"],
    ] as const) {
      await say(phone, `JOIN ${code}`);
      expect(m.last(phone)).toContain("You're in Asheville Trip with Amit! What should I call you?");
      await say(phone, name);
      expect(m.last(phone)).toContain(`Got it, ${name}.`);
    }
    m.clear();
    return code;
  }

  it("runs the whole story end to end", async () => {
    await setupTrip();

    // Everyone got a funded wallet without seeing any crypto.
    for (const p of [AMIT, JAKE, PRIYA, SAM]) expect(await chain.balance(store.userByPhone(p)!.pubkey!)).toBe(50000);

    // Amit: gas receipt, everyone
    ai.receipts.push(receipt("Shell", [["Gas", 8000]]));
    await say(AMIT, "gas, everyone", [PHOTO]);
    expect(m.last(AMIT)).toBe(
      "Logged to Asheville Trip: Gas $80.00 · split 4 ways ($20 each) · 🧾 receipt matched. I've asked Jake, Priya, and Sam to OK their shares.",
    );
    expect(m.last(JAKE)).toBe("Amit logged Gas $80.00 (🧾 receipt). Your share: $20.00. Reply YES, DISPUTE + reason, or WHY.");
    await say(JAKE, "YES");
    expect(m.last(JAKE)).toBe("✅ Approved.");

    // Priya: dinner without Amit
    m.clear();
    ai.receipts.push(receipt("Tupelo Honey", [["Shrimp & Grits", 3000], ["Burger", 2800], ["Salad", 2200]], 800, 800));
    await say(PRIYA, "dinner, me jake and sam, I didn't eat with Amit", [PHOTO]);
    expect(m.last(PRIYA)).toContain("Dinner $96.00 · split 3 ways ($32 each)");
    expect(m.all(AMIT)).toHaveLength(0);
    expect(m.last(SAM)).toContain("Your share: $32.00");

    // Sam: "pay me $30" -> asks what for -> firewood, no receipt
    await say(SAM, "pay me $30");
    expect(m.last(SAM)).toBe("What was the $30 for? A receipt photo helps.");
    await say(SAM, "firewood");
    expect(m.last(SAM)).toBe(
      "Logged to Asheville Trip: Firewood $30.00 · split 4 ways ($7.50 each) · ⚠️ no receipt. Everyone has to approve it themselves.",
    );

    // Amit disputes
    await say(AMIT, "DISPUTE I don't remember any firewood");
    expect(m.last(AMIT)).toBe("Disputed. I asked Sam for a receipt or a fix. Your $7.50 won't count until it's sorted.");
    expect(m.last(SAM)).toContain(`Amit disputed Firewood ($7.50): "I don't remember any firewood"`);

    // Sam sends the receipt -> everyone re-asked, Amit first
    m.clear();
    now += 24 * 3600_000; // Oct 12
    ai.receipts.push(receipt("Gas station", [["Firewood", 3000]]));
    await say(SAM, "", [PHOTO]);
    expect(m.last(SAM)).toContain("🧾 Receipt added to Firewood");
    expect(m.last(AMIT)).toBe("Sam added a receipt for Firewood $30.00. Your share: $7.50. Reply YES, DISPUTE + reason, or WHY.");
    expect([...m.inbox.keys()].indexOf(AMIT)).toBeLessThan([...m.inbox.keys()].indexOf(JAKE));

    // Jake approves dinner, then asks why
    await say(JAKE, "yes");
    expect(m.last(JAKE)).toContain("✅ Approved Dinner. Next: Firewood $7.50 (Sam)");
    await say(JAKE, "why do I owe so much");
    const why = m.last(JAKE);
    expect(why).toContain("• $20.00 to Amit: Gas ($80 ÷ 4), receipt Oct 11, you approved");
    expect(why).toContain("• $32.00 to Priya: Dinner ($96 ÷ 3), receipt Oct 11, you approved");
    expect(why).toContain("• $7.50 to Sam: Firewood ($30 ÷ 4), receipt added Oct 12, still waiting on your OK");

    // Priya settles; only approved shares count
    m.clear();
    await say(PRIYA, "SETTLE");
    expect(m.last(JAKE)).toContain("You owe Priya $32.00 and Amit $20.00 for Asheville Trip.");
    expect(m.last(JAKE)).toContain("Reply PAY to send USDC");
    expect(m.last(JAKE)).toContain("1 expense still waiting on your OK isn't included yet.");

    // Jake pays
    await say(JAKE, "PAY");
    expect(m.last(JAKE)).toMatch(/^✅ Sent \$52\.00 USDC: Priya \$32, Amit \$20/);
    expect(m.last(AMIT)).toContain("💸 Jake paid you $20.00 USDC");
    expect(m.last(PRIYA)).toContain("💸 Jake paid you $32.00 USDC");
    expect(await chain.balance(store.userByPhone(JAKE)!.pubkey!)).toBe(50000 - 5200);
    await say(JAKE, "PAY");
    expect(m.last(JAKE)).toBe("You don't owe anything right now 🎉");

    // A day after dinner was logged, Sam still hasn't approved it -> reminder (before the 48h auto-approve)
    m.clear();
    now += 1 * 3600_000;
    await bot.runJobs();
    expect(m.all(SAM).join("\n")).toContain("Dinner $32.00 (Priya)");
    expect(m.all(SAM).join("\n")).toMatch(/^Reminder: \d+ expenses? needs? your OK/m);
  });

  it("supports split by item", async () => {
    await setupTrip();
    ai.receipts.push(receipt("Pizza Place", [["Pepperoni", 1800], ["Veggie", 1600], ["Wings", 1200], ["Soda", 400]], 400));
    await say(PRIYA, "", [PHOTO]);
    expect(m.last(PRIYA)).toContain("Split evenly with everyone, or by item?");
    await say(PRIYA, "by item");
    expect(m.last(PRIYA)).toContain("1) Pepperoni $18.00");
    await say(PRIYA, "1,3 Sam; 2 Jake; rest everyone");
    expect(m.last(PRIYA)).toContain("split by item");
    const e = store.expenses(store.userByPhone(PRIYA)!.active_trip_id!)[0]!;
    const shares = store.shares(e.id);
    expect(shares.reduce((a, s) => a + s.cents, 0)).toBe(5400);
    expect(shares).toHaveLength(4);
  });

  it("auto-approves receipt-backed shares but never no-receipt ones", async () => {
    await setupTrip();
    ai.receipts.push(receipt("Shell", [["Gas", 8000]]));
    await say(AMIT, "gas, everyone", [PHOTO]);
    await say(SAM, "paid 30 for firewood");
    now += 49 * 3600_000;
    await bot.runJobs();
    const trip = store.userByPhone(AMIT)!.active_trip_id!;
    const [gas, firewood] = store.expenses(trip);
    expect(store.shares(gas!.id).every((s) => s.status === "approved")).toBe(true);
    expect(store.shares(firewood!.id).filter((s) => s.status === "pending")).toHaveLength(3);
  });

  it("tells strangers how to start", async () => {
    await say("+15559999999", "hi");
    expect(m.last("+15559999999")).toContain('Text "new trip <name>"');
  });
});
