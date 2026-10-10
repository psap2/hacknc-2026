/**
 * Money math. All amounts are integer cents; nothing here ever touches floats
 * except for the proportional weights inside `allocate`.
 */

/**
 * Split `total` into parts proportional to `weights` using the largest-remainder
 * method, so the parts always sum to exactly `total`. Ties go to the earlier index.
 */
export function allocate(total: number, weights: number[]): number[] {
  if (!Number.isInteger(total)) throw new Error(`total must be integer cents, got ${total}`);
  if (weights.length === 0) throw new Error("allocate needs at least one weight");
  const sum = weights.reduce((a, b) => a + b, 0);
  // All-zero weights (e.g. tax on a receipt where nothing was assigned yet): split evenly.
  const w = sum === 0 ? weights.map(() => 1) : weights;
  const wsum = sum === 0 ? w.length : sum;

  const exact = w.map((x) => (total * x) / wsum);
  const parts = exact.map((x) => Math.floor(x));
  let left = total - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) parts[order[k]!.i]! += 1;
  return parts;
}

/** Even split among `userIds`. Returns userId -> cents. */
export function splitEven(totalCents: number, userIds: number[]): Map<number, number> {
  const ids = [...new Set(userIds)];
  const parts = allocate(totalCents, ids.map(() => 1));
  return new Map(ids.map((id, i) => [id, parts[i]!]));
}

export interface ReceiptItem {
  name: string;
  qty: number;
  price_cents: number; // line total for this item (qty already applied)
}

export interface Receipt {
  merchant: string;
  date: string | null;
  items: ReceiptItem[];
  subtotal_cents: number;
  tax_cents: number;
  tip_cents: number;
  total_cents: number;
}

/**
 * Itemized split. `assignments[i]` lists who shared item i (split evenly among them).
 * Tax, tip and any rounding gap between the items and `totalCents` are spread in
 * proportion to each person's item subtotal.
 */
export function splitItems(
  items: ReceiptItem[],
  assignments: number[][],
  totalCents: number,
): Map<number, number> {
  if (assignments.length !== items.length) {
    throw new Error(`expected ${items.length} assignments, got ${assignments.length}`);
  }
  const itemCents = new Map<number, number>();
  items.forEach((item, i) => {
    const who = [...new Set(assignments[i]!)];
    if (who.length === 0) throw new Error(`item ${i + 1} (${item.name}) has nobody assigned`);
    for (const [id, c] of splitEven(item.price_cents, who)) itemCents.set(id, (itemCents.get(id) ?? 0) + c);
  });

  const ids = [...itemCents.keys()];
  const itemsTotal = ids.reduce((a, id) => a + itemCents.get(id)!, 0);
  const extra = totalCents - itemsTotal; // tax + tip (+/- OCR rounding)
  const extraParts =
    extra >= 0
      ? allocate(extra, ids.map((id) => itemCents.get(id)!))
      : allocate(-extra, ids.map((id) => itemCents.get(id)!)).map((x) => -x);

  return new Map(ids.map((id, i) => [id, itemCents.get(id)! + extraParts[i]!]));
}

/** Sanity check for OCR output: do the items add up to the subtotal (±1¢ per item)? */
export function receiptLooksConsistent(r: Receipt): boolean {
  const items = r.items.reduce((a, it) => a + it.price_cents, 0);
  const subtotalOk = r.subtotal_cents === 0 || Math.abs(items - r.subtotal_cents) <= r.items.length;
  const totalOk =
    Math.abs(r.subtotal_cents + r.tax_cents + r.tip_cents - r.total_cents) <= 2 || r.subtotal_cents === 0;
  return subtotalOk && totalOk;
}

export function fmt(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** Parse "$40", "40.5", "1,234.56" into cents. Returns null if it isn't a money amount. */
export function parseCents(s: string): number | null {
  const m = s.replace(/[$,\s]/g, "").match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, "0")) : 0);
}
