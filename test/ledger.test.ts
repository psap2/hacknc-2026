import { describe, expect, it } from "vitest";
import { heuristicAssign, heuristicIntent } from "../src/ai/heuristic.js";
import { minTransfers } from "../src/ledger/settle.js";
import { allocate, fmt, parseCents, splitEven, splitItems } from "../src/ledger/split.js";

const sum = (m: Map<number, number> | number[]) => [...(Array.isArray(m) ? m : m.values())].reduce((a, b) => a + b, 0);

describe("allocate / splitEven", () => {
  it("always sums to the total", () => {
    for (const total of [0, 1, 99, 100, 1001, 9999]) {
      for (const n of [1, 2, 3, 7]) expect(sum(allocate(total, Array(n).fill(1)))).toBe(total);
    }
  });
  it("splits $10 three ways as 334/333/333", () => {
    expect([...splitEven(1000, [1, 2, 3]).values()]).toEqual([334, 333, 333]);
  });
  it("dedupes ids", () => {
    expect(splitEven(800, [1, 1, 2]).size).toBe(2);
  });
});

describe("splitItems", () => {
  it("prorates tax and tip by item subtotal", () => {
    // Sam: wings $10 ; Jo: pasta $20 ; shared bread $6 ; tax+tip $9 -> total $45
    const items = [
      { name: "Wings", qty: 1, price_cents: 1000 },
      { name: "Pasta", qty: 1, price_cents: 2000 },
      { name: "Bread", qty: 1, price_cents: 600 },
    ];
    const out = splitItems(items, [[1], [2], [1, 2]], 4500);
    expect(sum(out)).toBe(4500);
    // Sam items 1300, Jo 2300 -> extra 900 split 1300:2300
    expect(out.get(1)).toBe(1300 + 325);
    expect(out.get(2)).toBe(2300 + 575);
  });
  it("throws when an item has nobody", () => {
    expect(() => splitItems([{ name: "x", qty: 1, price_cents: 100 }], [[]], 100)).toThrow();
  });
});

describe("minTransfers", () => {
  it("settles with at most n-1 payments", () => {
    const net = new Map([
      [1, 5000],
      [2, -2000],
      [3, -3200],
      [4, 200],
    ]);
    const plan = minTransfers(net);
    expect(plan.length).toBeLessThanOrEqual(3);
    const after = new Map(net);
    for (const d of plan) {
      after.set(d.from, after.get(d.from)! + d.cents);
      after.set(d.to, after.get(d.to)! - d.cents);
    }
    expect([...after.values()].every((v) => v === 0)).toBe(true);
  });
});

describe("parsing", () => {
  const ctx = { senderName: "Priya", memberNames: ["Amit", "Jake", "Priya", "Sam"], hasImage: false };
  it("parses money", () => {
    expect(parseCents("$40")).toBe(4000);
    expect(parseCents("1,234.5")).toBe(123450);
    expect(parseCents("abc")).toBeNull();
    expect(fmt(752)).toBe("$7.52");
  });
  it("understands 'dinner, me jake and sam, I didn't eat with Amit'", () => {
    const i = heuristicIntent("dinner, me jake and sam, I didn't eat with Amit", { ...ctx, hasImage: true });
    expect(i.kind).toBe("expense");
    if (i.kind !== "expense") return;
    expect(i.split.mode).toBe("only");
    expect(i.split.names.sort()).toEqual(["Jake", "Sam"]);
    expect(i.split.includeSender).toBe(true);
  });
  it("understands 'pay me $30' as an expense with no description", () => {
    const i = heuristicIntent("pay me $30", ctx);
    expect(i).toMatchObject({ kind: "expense", amountCents: 3000, description: null });
  });
  it("understands 'paid $40 for snacks'", () => {
    expect(heuristicIntent("paid $40 for snacks", ctx)).toMatchObject({ kind: "expense", amountCents: 4000, description: "Snacks" });
  });
  it("parses item assignments", () => {
    expect(heuristicAssign("1,3 Sam; 2 Jake; rest everyone", 4, ctx)).toEqual([
      { item: 0, names: ["Sam"] },
      { item: 1, names: ["Jake"] },
      { item: 2, names: ["Sam"] },
      { item: 3, names: ["Amit", "Jake", "Priya", "Sam"] },
    ]);
  });
});
