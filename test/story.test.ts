import { beforeEach, describe, expect, it } from "vitest";
import { Tab } from "../src/agent/bot.js";
import { HeuristicAI } from "../src/ai/heuristic.js";
import { openDb, Store } from "../src/ledger/db.js";
import { tripLedger } from "../src/ledger/settle.js";
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
  async register() {
    return undefined;
  }
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

    // Amit: gas receipt, everyone. Shares count immediately; nobody is asked to approve.
    ai.receipts.push(receipt("Shell", [["Gas", 8000]]));
    await say(AMIT, "gas, everyone", [PHOTO]);
    expect(m.last(AMIT)).toBe("Logged to Asheville Trip: Gas $80.00 · split 4 ways ($20 each). I've told Jake, Priya, and Sam.");
    expect(m.last(JAKE)).toBe(
      "Amit logged Gas $80.00 · your share $20.00. Reply DISPUTE + reason if that's wrong.",
    );
    await say(JAKE, "YES");
    expect(m.last(JAKE)).toContain("No need to approve anything");

    // Priya: dinner without Amit. Jake's running total now spans two people.
    m.clear();
    ai.receipts.push(receipt("Tupelo Honey", [["Shrimp & Grits", 3000], ["Burger", 2800], ["Salad", 2200]], 800, 800));
    await say(PRIYA, "dinner, me jake and sam, I didn't eat with Amit", [PHOTO]);
    expect(m.last(PRIYA)).toContain("Dinner $96.00 · split 3 ways ($32 each)");
    expect(m.all(AMIT)).toHaveLength(0);
    expect(m.last(JAKE)).toContain("your share $32.00.");
    expect(m.last(JAKE)).not.toContain("Running total");

    // Sam: "pay me $30" -> asks what for -> firewood, no receipt
    await say(SAM, "pay me $30");
    expect(m.last(SAM)).toBe("What was the $30 for? A receipt photo helps.");
    await say(SAM, "firewood");
    expect(m.last(SAM)).toBe("Logged to Asheville Trip: Firewood $30.00 · split 4 ways ($7.50 each). I've told Amit, Jake, and Priya.");
    // Per-expense texts stay short; TOTAL nets what Sam owes Amit against what Amit now owes Sam.
    expect(m.last(AMIT)).toBe("Sam logged Firewood $30.00 · your share $7.50. Reply DISPUTE + reason if that's wrong.");
    await say(AMIT, "TOTAL");
    expect(m.last(AMIT)).toContain("running total: Jake owes you $20.00, Priya owes you $20.00, and Sam owes you $12.50.");

    // Amit disputes the firewood (by name, so it doesn't matter that it isn't his latest).
    await say(AMIT, "DISPUTE I don't remember any firewood");
    expect(m.last(AMIT)).toBe(
      "Disputed Firewood. Your $7.50 won't count until Sam adds a receipt or takes you off it. (Reply YES if you change your mind.)",
    );
    expect(m.last(SAM)).toContain(`Amit disputed Firewood ($7.50): "I don't remember any firewood"`);

    // Sam sends the receipt -> only the disputer hears about it, and the share counts again.
    m.clear();
    now += 24 * 3600_000; // Oct 12
    ai.receipts.push(receipt("Gas station", [["Firewood", 3000]]));
    await say(SAM, "", [PHOTO]);
    expect(m.last(SAM)).toBe("Receipt added to Firewood. Amit is counted again.");
    expect(m.last(AMIT)).toContain("Sam added a receipt for Firewood $30.00, so your $7.50 counts again.");
    expect(m.all(JAKE)).toHaveLength(0);

    // Jake asks why, then for his total.
    await say(JAKE, "why do I owe so much");
    const why = m.last(JAKE);
    expect(why).toContain("You owe $59.50 total:");
    expect(why).toContain("• $20.00 to Amit: Gas ($80 ÷ 4), receipt Oct 11, counted");
    expect(why).toContain("• $32.00 to Priya: Dinner ($96 ÷ 3), receipt Oct 11, counted");
    expect(why).toContain("• $7.50 to Sam: Firewood ($30 ÷ 4), receipt added Oct 12, counted");
    await say(JAKE, "what's my total");
    expect(m.last(JAKE)).toContain("Asheville Trip running total: you owe Amit $20.00, Priya $32.00, and Sam $7.50.");
    expect(m.last(JAKE)).toContain("Net: you owe $59.50.");
    expect(m.last(JAKE)).toContain("https://tab.test/t/");

    // Priya settles: fewest payments, everything counted. Jake's $59.50 is routed as
    // $52.50 to Amit + $7 to Priya (two payments) rather than one per person he owes.
    m.clear();
    await say(PRIYA, "SETTLE");
    expect(m.last(JAKE)).toContain("You owe Amit $52.50 and Priya $7.00 for Asheville Trip.");
    expect(m.last(JAKE)).toContain("Reply PAY to send USDC");

    // Jake pays
    await say(JAKE, "PAY");
    expect(m.last(JAKE)).toMatch(/^✅ Sent \$59\.50 USDC: Amit \$52\.50, Priya \$7\n/);
    expect(m.last(AMIT)).toContain("💸 Jake paid you $52.50 USDC");
    expect(m.last(PRIYA)).toContain("💸 Jake paid you $7.00 USDC");
    expect(await chain.balance(store.userByPhone(JAKE)!.pubkey!)).toBe(50000 - 5950);
    await say(JAKE, "PAY");
    expect(m.last(JAKE)).toBe("You don't owe anything right now 🎉");

    // Reminders: one running-total text a day, only for people who owe, and never twice in a day.
    m.clear();
    await bot.runJobs();
    expect(m.all(SAM)).toHaveLength(0); // settle-up told Sam his total minutes ago
    now += 25 * 3600_000;
    await bot.runJobs();
    expect(m.all(SAM)).toHaveLength(1);
    expect(m.last(SAM)).toMatch(/^Daily total for Asheville Trip: you owe .*Net: you owe \$29\.50\. Reply PAY/);
    expect(m.all(JAKE)).toHaveLength(0); // paid up
    expect(m.all(AMIT)).toHaveLength(0); // owed, not owing
    await bot.runJobs();
    expect(m.all(SAM)).toHaveLength(1);

    // A creditor can poke someone directly; it only goes to people who actually owe them.
    m.clear();
    await say(PRIYA, "remind Sam and Jake");
    expect(m.last(SAM)).toContain("👋 Priya asked me to remind you: you owe Priya $24.50 for Asheville Trip. Running total: you owe Amit $12.50 and Priya $24.50 · Jake owes you $7.50.");
    expect(m.all(JAKE)).toHaveLength(0);
    expect(m.last(PRIYA)).toBe("Reminded Sam ($24.50). Jake doesn't owe you anything right now.");
  });

  it("nets what two people owe each other into one payment", async () => {
    await setupTrip();
    const trip = store.userByPhone(AMIT)!.active_trip_id!;
    await say(JAKE, "paid $40 for lunch, me and Priya");
    await say(PRIYA, "paid $50 for drinks, me and Jake");
    // Jake owes Priya $25, Priya owes Jake $20 -> Jake owes Priya $5. One payment, not two.
    await say(JAKE, "TOTAL");
    expect(m.last(JAKE)).toContain("running total: you owe Priya $5.00.");
    const { plan } = tripLedger(store, trip);
    expect(plan).toEqual([{ from: store.userByPhone(JAKE)!.id, to: store.userByPhone(PRIYA)!.id, cents: 500 }]);
    await say(PRIYA, "TOTAL");
    expect(m.last(PRIYA)).toContain("running total: Jake owes you $5.00.");
    expect(m.last(PRIYA)).toContain("Net: you're owed $5.00.");
  });

  it("a dispute stops the share counting until it's resolved, and YES takes it back", async () => {
    await setupTrip();
    await say(SAM, "paid 30 for firewood");
    const trip = store.userByPhone(AMIT)!.active_trip_id!;
    const firewood = store.expenses(trip)[0]!;
    expect(store.shares(firewood.id).every((s) => s.status === "approved")).toBe(true);
    await say(AMIT, "DISPUTE never saw it");
    expect(store.shares(firewood.id).find((s) => s.user_id === store.userByPhone(AMIT)!.id)!.status).toBe("disputed");
    expect(tripLedger(store, trip).net.get(store.userByPhone(AMIT)!.id)).toBe(0);
    await say(AMIT, "yes");
    expect(m.last(AMIT)).toContain("Counting Firewood $7.50 again");
    expect(m.last(SAM)).toContain("Amit is fine with Firewood after all");
    expect(tripLedger(store, trip).net.get(store.userByPhone(AMIT)!.id)).toBe(-750);
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

  it("tells strangers how to start", async () => {
    await say("+15559999999", "hi");
    expect(m.last("+15559999999")).toContain('Text "new trip <name>"');
  });
});
