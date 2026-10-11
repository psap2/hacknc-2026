import { describe, expect, it } from "vitest";
import { parseName, Tab } from "../src/agent/bot.js";
import { HeuristicAI } from "../src/ai/heuristic.js";
import { openDb, Store } from "../src/ledger/db.js";
import type { InboundHandler, Messenger } from "../src/messaging/types.js";
import { MockChain } from "../src/solana/chain.js";

/** Refuses sends to a phone until `allow()` is called, like Photon right after registering someone. */
class GatedMessenger implements Messenger {
  sent: [string, string][] = [];
  blocked = new Set<string>();
  constructor(private readonly line: string | undefined) {}
  async start(_: InboundHandler) {}
  async send(phone: string, text: string) {
    if (this.blocked.has(phone)) throw new Error("[spectrum-imessage] Target not allowed for this project");
    this.sent.push([phone, text]);
  }
  async register() {
    return this.line;
  }
  async stop() {}
  to(phone: string) {
    return this.sent.filter(([p]) => p === phone).map(([, t]) => t);
  }
}

const AMIT = "+15550000001";
const JAKE = "+15550000002";
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(m: Messenger) {
  const store = new Store(openDb(":memory:"));
  const bot = new Tab({
    store,
    messenger: m,
    ai: new HeuristicAI(),
    chain: new MockChain(),
    now: () => Date.parse("2026-10-11T12:00:00Z"),
    config: { botName: "Tab", publicUrl: "https://tab.test", botPhone: "", startingBalanceCents: 500_00, reminderGapMs: 0 },
  });
  return { store, bot };
}

async function makeTrip(bot: Tab, store: Store) {
  await bot.handle({ phone: AMIT, text: "new trip Asheville", images: [] });
  await bot.handle({ phone: AMIT, text: "Amit", images: [] });
  return store.allTrips()[0]!;
}

describe("joining from the web invite", () => {
  it("enrolls immediately, greets in the background, then asks for a name", async () => {
    const m = new GatedMessenger("+14155550100");
    const { store, bot } = setup(m);
    const trip = await makeTrip(bot, store);
    const r = await bot.joinByPhone(JAKE, trip.code);
    expect(r).toEqual({ line: "+14155550100" });
    expect(store.isMember(trip.id, store.userByPhone(JAKE)!.id)).toBe(true);
    await flush();
    expect(m.to(JAKE).at(-1)).toContain("What should I call you?");
    await bot.handle({ phone: JAKE, text: "Jake", images: [] });
    expect(m.to(AMIT).at(-1)).toBe("Jake joined Asheville Trip 🎉");
  });

  it("when the greeting never lands, a hello is not taken as the name", async () => {
    const m = new GatedMessenger("+14155550100");
    m.blocked.add(JAKE);
    const { store, bot } = setup(m);
    const trip = await makeTrip(bot, store);
    await bot.joinByPhone(JAKE, trip.code);
    await flush();
    const jake = store.userByPhone(JAKE)!;
    expect(store.isMember(trip.id, jake.id)).toBe(true);
    expect(store.getPending(jake.id)).toBeUndefined(); // nothing was asked, so nothing is pending

    // A minute later Photon lets us through and Jake says hi first.
    m.blocked.delete(JAKE);
    await bot.handle({ phone: JAKE, text: "Hi", images: [] });
    expect(store.user(jake.id).name).toBeNull();
    expect(m.to(JAKE).at(-1)).toContain("What should I call you?");

    await bot.handle({ phone: JAKE, text: "hey", images: [] }); // still not a name
    expect(store.user(jake.id).name).toBeNull();
    expect(m.to(JAKE).at(-1)).toContain("What should I call you?");

    await bot.handle({ phone: JAKE, text: "Ayug", images: [] });
    expect(store.user(jake.id).name).toBe("Ayug");
    expect(m.to(AMIT).at(-1)).toBe("Ayug joined Asheville Trip 🎉");
  });

  it("lets a person fix a wrong name with 'call me'", async () => {
    const m = new GatedMessenger(undefined);
    const { store, bot } = setup(m);
    const trip = await makeTrip(bot, store);
    await bot.handle({ phone: JAKE, text: `JOIN ${trip.code}`, images: [] });
    await bot.handle({ phone: JAKE, text: "Jake", images: [] });
    await bot.handle({ phone: JAKE, text: "call me Ayug", images: [] });
    expect(store.userByPhone(JAKE)!.name).toBe("Ayug");
    expect(m.to(JAKE).at(-1)).toContain("Ayug");
    await bot.handle({ phone: JAKE, text: "paid $40 for snacks", images: [] });
    expect(m.to(AMIT).at(-1)).toContain("Ayug"); // approvals use the new name
  });

  it("understands several ways of starting a trip", async () => {
    const m = new GatedMessenger(undefined);
    const { store, bot } = setup(m);
    for (const [phone, text] of [
      ["+15550000011", "new nashville trip"],
      ["+15550000012", "New Trip Nepal"],
      ["+15550000013", "start a trip to Asheville"],
      ["+15550000014", "trip: Beach Week"],
      ["+15550000015", "i am going on a new trip to florida"],
    ] as const) {
      await bot.handle({ phone, text, images: [] });
      expect(m.to(phone)[0]).toMatch(/Trip created!/);
    }
    expect(store.allTrips().map((t) => t.name).sort()).toEqual(["Asheville Trip", "Beach Week Trip", "Florida Trip", "Nashville Trip", "Nepal Trip"]);
  });

  it("asks for a name when someone says 'new trip' without one", async () => {
    const m = new GatedMessenger(undefined);
    const { store, bot } = setup(m);
    await bot.handle({ phone: "+15550000016", text: "start a new trip", images: [] });
    expect(m.to("+15550000016").at(-1)).toContain("What should I call the trip?");
    await bot.handle({ phone: "+15550000016", text: "Big Sur", images: [] });
    expect(m.to("+15550000016").at(-3)).toMatch(/Big Sur Trip created!/);
    expect(store.allTrips().map((t) => t.name)).toEqual(["Big Sur Trip"]);
  });

  it("switches trips from inside a trip with casual wording", async () => {
    const m = new GatedMessenger(undefined);
    const { store, bot } = setup(m);
    await makeTrip(bot, store);
    await bot.handle({ phone: AMIT, text: "ok we're going on a trip to Florida in march", images: [] });
    expect(m.to(AMIT).at(-3)).toMatch(/Florida Trip created!/);
    expect(m.to(AMIT).at(-1)).toContain("You're also in Asheville Trip");
    expect(store.allTrips().map((t) => t.name).sort()).toEqual(["Asheville Trip", "Florida Trip"]);
  });

  it("takes a corrected amount when the reply to 'what was it for?' restates it", async () => {
    const m = new GatedMessenger(undefined);
    const { store, bot } = setup(m);
    const trip = await makeTrip(bot, store);
    await bot.handle({ phone: JAKE, text: `JOIN ${trip.code}`, images: [] });
    await bot.handle({ phone: JAKE, text: "Jake", images: [] });
    await bot.handle({ phone: AMIT, text: "pay me 2", images: [] });
    expect(m.to(AMIT).at(-1)).toContain("What was the $2 for?");
    await bot.handle({ phone: AMIT, text: "$2400 for flights split evenly", images: [] });
    expect(m.to(AMIT).at(-1)).toContain("Flights $2,400.00 · split 2 ways ($1,200 each)");
  });

  it("lets the payer agree with a dispute, taking that person off and re-splitting", async () => {
    const m = new GatedMessenger(undefined);
    const { store, bot } = setup(m);
    const trip = await makeTrip(bot, store);
    const SAM = "+15550000003";
    for (const [p, n] of [[JAKE, "Jake"], [SAM, "Sam"]] as const) {
      await bot.handle({ phone: p, text: `JOIN ${trip.code}`, images: [] });
      await bot.handle({ phone: p, text: n, images: [] });
    }
    await bot.handle({ phone: AMIT, text: "paid $30 for coffee, everyone", images: [] });
    await bot.handle({ phone: JAKE, text: "DISPUTE I wasn't at coffee", images: [] });
    expect(m.to(AMIT).at(-1)).toContain("reply AGREE to take Jake off it");
    await bot.handle({ phone: AMIT, text: "agree", images: [] });
    expect(m.to(AMIT).at(-1)).toBe("Done. Jake is off Coffee; it's now split 2 ways ($15 each).");
    expect(m.to(JAKE).at(-1)).toContain("you're off Coffee");
    expect(m.to(SAM).at(-1)).toContain("your share is now $15.00");
    const coffee = store.expenses(trip.id)[0]!;
    expect(store.shares(coffee.id).map((s) => [s.user_id, s.cents])).toEqual([
      [store.userByPhone(AMIT)!.id, 1500],
      [store.userByPhone(SAM)!.id, 1500],
    ]);
  });

  it("accepts JOIN with or without a space before the code", async () => {
    const m = new GatedMessenger(undefined);
    const { store, bot } = setup(m);
    const trip = await makeTrip(bot, store);
    await bot.handle({ phone: JAKE, text: `JOIN${trip.code}`, images: [] });
    expect(store.isMember(trip.id, store.userByPhone(JAKE)!.id)).toBe(true);
    expect(m.to(JAKE).at(-1)).toContain("What should I call you?");
  });
});

describe("reading a name out of a reply", () => {
  it("keeps the name and drops the chatter", () => {
    expect(parseName("Dan")).toBe("Dan");
    expect(parseName("Dan is here")).toBe("Dan");
    expect(parseName("hey it's kunal!")).toBe("Kunal");
    expect(parseName("I'm Mary Ann")).toBe("Mary Ann");
    expect(parseName("this is Priya, nice to meet you")).toBe("Priya");
  });
});
