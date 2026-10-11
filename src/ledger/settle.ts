import type { Expense, Share, Store, Transfer } from "./db.js";

export interface Debt {
  from: number;
  to: number;
  cents: number;
}

/**
 * Net position per member: positive = the group owes them, negative = they owe.
 * Only approved shares count; pending and disputed ones are ignored until resolved.
 */
export function netBalances(
  memberIds: number[],
  expenses: { expense: Expense; shares: Share[] }[],
  transfers: Transfer[],
): Map<number, number> {
  const net = new Map(memberIds.map((id) => [id, 0]));
  const add = (id: number, c: number) => net.set(id, (net.get(id) ?? 0) + c);
  for (const { expense, shares } of expenses) {
    for (const s of shares) {
      if (s.user_id === expense.payer_id || s.status !== "approved") continue;
      add(expense.payer_id, s.cents);
      add(s.user_id, -s.cents);
    }
  }
  for (const t of transfers) {
    add(t.from_id, t.cents);
    add(t.to_id, -t.cents);
  }
  return net;
}

/**
 * Fewest-payments settle: repeatedly match the biggest debtor with the biggest
 * creditor. n people with non-zero balances need at most n-1 payments.
 */
export function minTransfers(net: Map<number, number>): Debt[] {
  const debtors = [...net].filter(([, c]) => c < 0).map(([id, c]) => ({ id, c: -c }));
  const creditors = [...net].filter(([, c]) => c > 0).map(([id, c]) => ({ id, c }));
  const out: Debt[] = [];
  const byAmount = (a: { id: number; c: number }, b: { id: number; c: number }) => b.c - a.c || a.id - b.id;
  while (debtors.length && creditors.length) {
    debtors.sort(byAmount);
    creditors.sort(byAmount);
    const d = debtors[0]!;
    const cr = creditors[0]!;
    const amt = Math.min(d.c, cr.c);
    out.push({ from: d.id, to: cr.id, cents: amt });
    d.c -= amt;
    cr.c -= amt;
    if (d.c === 0) debtors.shift();
    if (cr.c === 0) creditors.shift();
  }
  return out;
}

export function tripLedger(store: Store, tripId: number) {
  const members = store.members(tripId);
  const expenses = store.expenses(tripId).map((expense) => ({ expense, shares: store.shares(expense.id) }));
  const transfers = store.transfers(tripId);
  const net = netBalances(
    members.map((m) => m.id),
    expenses,
    transfers,
  );
  return { members, expenses, transfers, net, plan: pairwisePlan(store, tripId, members.map((m) => m.id)) };
}

/**
 * Who pays whom: each pair of people nets what they owe each other into one direction, after
 * payments already made. This is the same model TOTAL, reminders and the trip page use, so
 * "you owe Amit $25" and "pay" always agree. (minTransfers would route money through third
 * people to save a payment or two, which reads as the wrong person getting paid.)
 */
export function pairwisePlan(store: Store, tripId: number, memberIds: number[]): Debt[] {
  const plan: Debt[] = [];
  for (const id of memberIds) {
    for (const p of pairwise(store, tripId, id)) {
      if (p.cents > 0) plan.push({ from: id, to: p.other, cents: p.cents });
    }
  }
  return plan;
}

/** Line items explaining what one user owes, for WHY. Includes pending/disputed so nothing is hidden. */
export function breakdownFor(store: Store, tripId: number, userId: number) {
  const lines: { expense: Expense; share: Share; payerId: number; splitCount: number }[] = [];
  for (const expense of store.expenses(tripId)) {
    if (expense.payer_id === userId) continue;
    const shares = store.shares(expense.id);
    const mine = shares.find((s) => s.user_id === userId);
    if (!mine) continue;
    lines.push({ expense, share: mine, payerId: expense.payer_id, splitCount: shares.length });
  }
  const paid = store.transfers(tripId).filter((t) => t.from_id === userId);
  const received = store.transfers(tripId).filter((t) => t.to_id === userId);
  return { lines, paid, received };
}

export interface PairLine {
  expense: Expense;
  cents: number;
  /** "i_owe": my share of their expense. "they_owe": their share of mine. */
  direction: "i_owe" | "they_owe";
  status: Share["status"];
}

export interface Pair {
  other: number;
  /** Positive: I owe them this much. Negative: they owe me. Only approved shares count. */
  cents: number;
  lines: PairLine[];
  paid: number;
  received: number;
}

/**
 * Running sum between one person and each other member, with the lines behind it, so a
 * "you owe Amit $45" can always be traced back to specific expenses and payments.
 */
export function pairwise(store: Store, tripId: number, userId: number): Pair[] {
  const expenses = store.expenses(tripId).map((e) => ({ expense: e, shares: store.shares(e.id) }));
  const transfers = store.transfers(tripId);
  return store
    .members(tripId)
    .filter((m) => m.id !== userId)
    .map((m) => {
      const lines: PairLine[] = [];
      let cents = 0;
      for (const { expense, shares } of expenses) {
        if (expense.payer_id === m.id) {
          const mine = shares.find((s) => s.user_id === userId);
          if (!mine) continue;
          lines.push({ expense, cents: mine.cents, direction: "i_owe", status: mine.status });
          if (mine.status === "approved") cents += mine.cents;
        } else if (expense.payer_id === userId) {
          const theirs = shares.find((s) => s.user_id === m.id);
          if (!theirs) continue;
          lines.push({ expense, cents: theirs.cents, direction: "they_owe", status: theirs.status });
          if (theirs.status === "approved") cents -= theirs.cents;
        }
      }
      const paid = transfers.filter((t) => t.from_id === userId && t.to_id === m.id).reduce((a, t) => a + t.cents, 0);
      const received = transfers.filter((t) => t.from_id === m.id && t.to_id === userId).reduce((a, t) => a + t.cents, 0);
      return { other: m.id, cents: cents - paid + received, lines, paid, received };
    })
    .filter((p) => p.cents !== 0 || p.lines.length > 0);
}
