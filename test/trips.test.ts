import { beforeEach, describe, expect, it } from "vitest";
import { Tab } from "../src/agent/bot.js";
import { HeuristicAI } from "../src/ai/heuristic.js";
import { openDb, Store } from "../src/ledger/db.js";
import type { InboundHandler, Messenger } from "../src/messaging/types.js";
import { MockChain } from "../src/solana/chain.js";
import { viewerToken } from "../src/web/viewer.js";

class FakeMessenger implements Messenger {
  sent: [string, string][] = [];
  async start(_: InboundHandler) {}
  async send(phone: string, text: string) {
    this.sent.push([phone, text]);
  }
  async register() {
    return undefined;
  }
  async stop() {}
  to(phone: string) {
    return this.sent.filter(([p]) => p === phone).map(([, t]) => t);
  }
  last(phone: string) {
    return this.to(phone).at(-1) ?? "";
  }
}

const AMIT = "+15550000001";
const JAKE = "+15550000002";
const SAM = "+15550000003";

describe("being in several trips at once", () => {
  let m: FakeMessenger;
  let store: Store;
  let bot: Tab;
  let now: number;
  const say = (phone: string, text: string) => bot.handle({ phone, text, images: [] });
  const tick = () => (now += 60_000);

  beforeEach(async () => {
    now = Date.parse("2026-10-11T12:00:00Z");
    m = new FakeMessenger();
    store = new Store(openDb(":memory:"));
    bot = new Tab({
      store,
      messenger: m,
      ai: new HeuristicAI(),
      chain: new MockChain(),
      now: () => now,
      config: { botName: "Tab", publicUrl: "https://tab.test", botPhone: "", startingBalanceCents: 500_00, reminderGapMs: 24 * 3600_000 },
    });
    // Amit and Jake share Florida and Nyc; Sam is only on Nyc.
    await say(AMIT, "new trip Florida");
    await say(AMIT, "Amit");
    const florida = store.allTrips()[0]!;
    tick();
    await say(AMIT, "new trip Nyc");
    const nyc = store.allTrips()[1]!;
    for (const [phone, name, codes] of [
      [JAKE, "Jake", [florida.code, nyc.code]],
      [SAM, "Sam", [nyc.code]],
    ] as const) {
      for (const code of codes) {
        await say(phone, `JOIN ${code}`);
        if (!store.userByPhone(phone)!.name) await say(phone, name);
      }
    }
    m.sent = [];
  });

  it("asks which trip when an expense doesn't say, and logs it where they pick", async () => {
    await say(AMIT, "paid $80 for gas");
    expect(m.last(AMIT)).toBe("Which trip is that for, Florida or Nyc?");
    expect(store.expenses(1)).toHaveLength(0);
    await say(AMIT, "florida");
    expect(m.to(AMIT).at(-1)).toBe("Logged to Florida Trip: Gas $80.00 · split 2 ways ($40 each). I've told Jake.");
    expect(m.last(JAKE)).toBe("Amit logged Gas $80.00 on Florida Trip · your share $40.00.");
    // Sam isn't on Florida, so he hears nothing.
    expect(m.to(SAM)).toHaveLength(0);
  });

  it("YES and a number also answer the question", async () => {
    await say(AMIT, "paid $80 for gas");
    await say(AMIT, "2");
    expect(m.to(AMIT).at(-1)).toMatch(/^Logged to Nyc Trip: Gas \$80\.00 · split 3 ways/);
    await say(AMIT, "paid $12 for coffee");
    expect(m.last(AMIT)).toBe("Which trip is that for, Florida or Nyc?");
    await say(AMIT, "yes"); // a bare yes means the one they used last
    expect(m.to(AMIT).at(-1)).toMatch(/^Logged to Nyc Trip: Coffee \$12\.00/);
  });

  it("doesn't ask when the trip is named inline, and keeps the name out of the description", async () => {
    await say(AMIT, "$30 for snacks, nyc");
    expect(m.last(AMIT)).toBe("Logged to Nyc Trip: Snacks $30.00 · split 3 ways ($10 each). I've told Jake and Sam.");
    await say(JAKE, "paid 60 for the florida rental car");
    expect(m.last(JAKE)).toBe("Logged to Florida Trip: Rental Car $60.00 · split 2 ways ($30 each). I've told Amit.");
    // Someone on one trip only is never asked.
    await say(SAM, "paid $9 for tolls");
    expect(m.last(SAM)).toMatch(/^Logged to Nyc Trip: Tolls/);
  });

  it("TOTAL covers every trip unless one is named", async () => {
    await say(AMIT, "$30 for snacks, nyc");
    await say(JAKE, "$60 rental car, florida");
    await say(AMIT, "TOTAL");
    expect(m.last(AMIT)).toBe(
      "Florida Trip: you owe Jake $30.00\nNyc Trip: Jake owes you $10.00 and Sam owes you $10.00",
    );
    await say(AMIT, "total florida");
    expect(m.last(AMIT)).toContain("Florida Trip running total: you owe Jake $30.00.");
    // The page link Tab texts you is personal, so the page opens on you instead of asking.
    const florida = store.allTrips()[0]!;
    const amit = store.userByPhone(AMIT)!;
    expect(m.last(AMIT)).toContain(`https://tab.test/t/${florida.code}?me=${viewerToken("dev-link-secret", florida.id, amit.id)}`);
    await say(SAM, "TOTAL");
    expect(m.last(SAM)).toContain("Nyc Trip running total: you owe Amit $10.00.");
  });

  it("disputes and undo find the right expense across trips", async () => {
    await say(AMIT, "$30 for snacks, nyc");
    tick();
    await say(AMIT, "$80 gas, florida");
    await say(JAKE, "dispute snacks, I brought my own");
    expect(m.last(JAKE)).toContain("I've taken Snacks ($10.00) on Nyc Trip off your total");
    expect(m.last(AMIT)).toContain("Jake disputed Snacks on Nyc Trip ($10.00)");
    await say(AMIT, "agree");
    expect(m.last(JAKE)).toBe("Amit agreed: you're off Snacks on Nyc Trip.");
    // Bare UNDO removes the newest thing they logged anywhere (gas); naming a trip narrows it.
    await say(AMIT, "UNDO");
    expect(m.to(AMIT).at(-1)).toContain("Removed Gas $80.00");
    await say(AMIT, "undo nyc");
    expect(m.to(AMIT).at(-1)).toContain("Removed Snacks $30.00");
  });

  it("closes a trip only once it's settled (or when told anyway), then stops asking", async () => {
    await say(JAKE, "$60 rental car, florida");
    await say(AMIT, "close florida");
    expect(m.last(AMIT)).toBe("Florida Trip isn't settled yet: Amit owes Jake $30.00.\nDid you all settle that outside Tab, or should I keep it open until it's paid?");
    await say(AMIT, "nah not yet");
    expect(m.last(AMIT)).toBe("Okay, I'll leave Florida Trip open.");
    expect(store.trip(1).closed_at).toBeNull();
    await say(AMIT, "close florida");
    await say(AMIT, "just close it, he still owes me");
    expect(m.last(AMIT)).toContain("Closed Florida Trip.");
    expect(m.last(AMIT)).toContain("You're still in Nyc Trip.");
    expect(m.last(JAKE)).toContain("Amit closed Florida Trip (with balances still open).");
    expect(store.trip(1).closed_at).toBe(now);
    // Only Nyc is open now, so nobody gets asked.
    await say(AMIT, "paid $20 for pizza");
    expect(m.last(AMIT)).toMatch(/^Logged to Nyc Trip: Pizza/);
    await say(AMIT, "we're done with nyc");
    expect(m.last(AMIT)).toMatch(/isn't settled yet/);
  });

  it("'we sorted it out ourselves' closes the trip and books the leftovers as paid outside Tab", async () => {
    await say(JAKE, "$60 rental car, florida");
    await say(AMIT, "you can close out florida, me and jake sorted that out already");
    expect(m.last(AMIT)).toContain("Closed Florida Trip.");
    expect(m.last(AMIT)).toContain("Marked as settled outside Tab: Amit → Jake $30.00.");
    expect(m.last(JAKE)).toContain("Amit closed Florida Trip and marked what was left as settled outside Tab.");
    expect(store.transfers(1)).toMatchObject([{ from_id: store.userByPhone(AMIT)!.id, to_id: store.userByPhone(JAKE)!.id, cents: 3000, tx_sig: null }]);
    expect(store.trip(1).closed_at).toBe(now);
  });

  it("'end all active trips' closes what's settled and lists what isn't", async () => {
    await say(JAKE, "$60 rental car, florida");
    await say(AMIT, "end all active trips");
    expect(m.last(AMIT)).toBe(
      "Closed Nyc Trip.\nFlorida Trip isn't settled yet: Amit owes Jake $30.00.\n" +
        "Did you all settle that outside Tab, or should I keep it open until it's paid?\nYou're still in Florida Trip.",
    );
    expect(m.last(SAM)).toContain("Amit closed Nyc Trip.");
    await say(AMIT, "leave it as is, just close it");
    expect(m.last(AMIT)).toContain("Closed Florida Trip.");
    expect(store.openTripsFor(store.userByPhone(AMIT)!.id)).toHaveLength(0);
    await say(AMIT, "paid $5 for gum");
    expect(m.last(AMIT)).toContain("All your trips are closed.");
  });

  it("PAY pays what you owe on every open trip, even if you last used a different one", async () => {
    await say(JAKE, "$60 rental car, florida");
    await say(SAM, "$30 pizza, nyc");
    // Amit's last-used trip is Nyc (he just read about it), but he owes on both.
    await say(AMIT, "total nyc");
    await say(AMIT, "PAY");
    expect(m.to(AMIT).at(-2)).toMatch(/^✅ Sent \$40\.00 USDC: Jake \(Florida Trip\) \$30, Sam \(Nyc Trip\) \$10/);
    expect(m.last(JAKE)).toContain("Amit paid you $30.00 USDC for Florida Trip.");
    // Florida is square now (Nyc isn't: Jake still owes Sam), so Tab offers to close it.
    expect(m.last(AMIT)).toBe("That squares up Florida Trip. Want me to close it?");
    await say(AMIT, "nah leave it");
    expect(m.last(AMIT)).toBe("Okay, leaving it as is.");
    expect(store.trip(1).closed_at).toBeNull();
    expect(store.transfers(1)).toHaveLength(1);
    expect(store.transfers(2)).toHaveLength(1);
    await say(AMIT, "PAY");
    expect(m.last(AMIT)).toBe("You don't owe anything right now 🎉");
  });

  it("the payer answers a dispute in plain words", async () => {
    await say(AMIT, "$30 for snacks, nyc");
    await say(JAKE, "that snacks charge is wrong, I didn't have any");
    expect(m.last(AMIT)).toBe('Jake disputed Snacks on Nyc Trip ($10.00): "that snacks charge is wrong, I didn\'t have any". Should I take Jake off it, or do you have a receipt?');
    await say(AMIT, "no he definitely ate them");
    expect(m.last(JAKE)).toContain("Amit says you did have Snacks. It stays off your total for now");
    await say(JAKE, "ok fine count it");
    expect(m.last(JAKE)).toBe("Counting Snacks $10.00 again.");
    expect(m.last(AMIT)).toContain("Jake is fine with Snacks after all");
  });

  it("a new expense replaces the parked one instead of answering the question", async () => {
    await say(AMIT, "paid $80 for gas");
    await say(AMIT, "actually $90 for gas, florida");
    expect(m.last(AMIT)).toMatch(/^Logged to Florida Trip: Gas \$90\.00/);
    expect(store.getPending(store.userByPhone(AMIT)!.id)).toBeUndefined();
  });

  it("daily reminders skip closed trips", async () => {
    await say(JAKE, "$60 rental car, florida");
    await say(AMIT, "close florida");
    await say(AMIT, "yeah we're square, venmo'd");
    expect(m.last(AMIT)).toContain("Marked as settled outside Tab");
    m.sent = [];
    now += 2 * 24 * 3600_000;
    await bot.runJobs();
    expect(m.sent).toHaveLength(0);
  });
});
