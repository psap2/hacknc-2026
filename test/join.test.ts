import { describe, expect, it } from "vitest";
import { Tab } from "../src/agent/bot.js";
import { HeuristicAI } from "../src/ai/heuristic.js";
import { openDb, Store } from "../src/ledger/db.js";
import type { InboundHandler, Messenger } from "../src/messaging/types.js";
import { MockChain } from "../src/solana/chain.js";

/** Refuses the first N sends to a phone, like Photon right after registering someone. */
class FlakyMessenger implements Messenger {
  sent: [string, string][] = [];
  failuresLeft = new Map<string, number>();
  constructor(private readonly line: string | undefined) {}
  async start(_: InboundHandler) {}
  async send(phone: string, text: string) {
    const left = this.failuresLeft.get(phone) ?? 0;
    if (left > 0) {
      this.failuresLeft.set(phone, left - 1);
      throw new Error("[spectrum-imessage] Target not allowed for this project");
    }
    this.sent.push([phone, text]);
  }
  async register() {
    return this.line;
  }
  async stop() {}
}

const AMIT = "+15550000001";
const JAKE = "+15550000002";

function setup(m: Messenger) {
  const store = new Store(openDb(":memory:"));
  const bot = new Tab({
    store,
    messenger: m,
    ai: new HeuristicAI(),
    chain: new MockChain(),
    now: () => Date.parse("2026-10-11T12:00:00Z"),
    config: { botName: "Tab", publicUrl: "https://tab.test", botPhone: "", startingBalanceCents: 500_00, autoApproveMs: 0, reminderGapMs: 0 },
  });
  return { store, bot };
}

async function makeTrip(bot: Tab, store: Store) {
  await bot.handle({ phone: AMIT, text: "new trip Asheville", images: [] });
  await bot.handle({ phone: AMIT, text: "Amit", images: [] });
  return store.allTrips()[0]!;
}

describe("joining from the web invite", () => {
  it("texts the person when the platform allows it", async () => {
    const m = new FlakyMessenger("+14155550100");
    const { store, bot } = setup(m);
    const trip = await makeTrip(bot, store);
    const r = await bot.joinByPhone(JAKE, trip.code);
    expect(r).toEqual({ texted: true, line: "+14155550100" });
    expect(m.sent.at(-1)).toEqual([JAKE, expect.stringContaining("What should I call you?")]);
    expect(store.isMember(trip.id, store.userByPhone(JAKE)!.id)).toBe(true);
  });

  it("retries once, then still enrolls and hands back the line to text", async () => {
    const m = new FlakyMessenger("+14155550100");
    m.failuresLeft.set(JAKE, 2); // first try + the one retry
    const { store, bot } = setup(m);
    const trip = await makeTrip(bot, store);
    const r = await bot.joinByPhone(JAKE, trip.code);
    expect(r).toEqual({ texted: false, line: "+14155550100" });
    const jake = store.userByPhone(JAKE)!;
    expect(store.isMember(trip.id, jake.id)).toBe(true);
    expect(m.sent.some(([p]) => p === JAKE)).toBe(false);

    // When they text in, they're greeted and asked for a name rather than told "already in".
    await bot.handle({ phone: JAKE, text: `JOIN ${trip.code}`, images: [] });
    expect(m.sent.at(-1)).toEqual([JAKE, expect.stringContaining("What should I call you?")]);
    await bot.handle({ phone: JAKE, text: "Jake", images: [] });
    expect(store.user(jake.id).name).toBe("Jake");
    expect(m.sent.at(-1)).toEqual([AMIT, "Jake joined Asheville Trip 🎉"]);
  }, 10_000);
});
