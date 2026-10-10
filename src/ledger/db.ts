import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type DB = Database.Database;

export type ShareStatus = "pending" | "approved" | "disputed";
export type ExpenseStatus = "active" | "deleted";

export interface User {
  id: number;
  phone: string;
  name: string | null;
  pubkey: string | null;
  enc_secret: string | null;
  active_trip_id: number | null;
  created_at: number;
}

export interface Trip {
  id: number;
  name: string;
  code: string;
  organizer_id: number;
  created_at: number;
  settle_requested_at: number | null;
}

export interface Expense {
  id: number;
  trip_id: number;
  payer_id: number;
  description: string;
  total_cents: number;
  has_receipt: number; // 0 | 1
  receipt_json: string | null;
  status: ExpenseStatus;
  created_at: number;
  receipt_at: number | null;
}

export interface Share {
  expense_id: number;
  user_id: number;
  cents: number;
  status: ShareStatus;
  dispute_reason: string | null;
  decided_at: number | null;
  notified_at: number | null;
  reminded_at: number | null;
}

export interface Transfer {
  id: number;
  trip_id: number;
  from_id: number;
  to_id: number;
  cents: number;
  tx_sig: string | null;
  status: "sent" | "failed";
  created_at: number;
}

export interface Pending {
  user_id: number;
  kind: string;
  payload: string;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,
  pubkey TEXT,
  enc_secret TEXT,
  active_trip_id INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  organizer_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  settle_requested_at INTEGER
);
CREATE TABLE IF NOT EXISTS members (
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, user_id)
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  payer_id INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  total_cents INTEGER NOT NULL,
  has_receipt INTEGER NOT NULL DEFAULT 0,
  receipt_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  receipt_at INTEGER
);
CREATE TABLE IF NOT EXISTS shares (
  expense_id INTEGER NOT NULL REFERENCES expenses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  dispute_reason TEXT,
  decided_at INTEGER,
  notified_at INTEGER,
  reminded_at INTEGER,
  PRIMARY KEY (expense_id, user_id)
);
CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  from_id INTEGER NOT NULL REFERENCES users(id),
  to_id INTEGER NOT NULL REFERENCES users(id),
  cents INTEGER NOT NULL,
  tx_sig TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_nudges (
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  at INTEGER NOT NULL,
  PRIMARY KEY (trip_id, user_id)
);
CREATE TABLE IF NOT EXISTS pending (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function openDb(path: string): DB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

/** Thin query helpers. Everything takes `now` explicitly so tests can control time. */
export class Store {
  constructor(readonly db: DB) {}

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- users
  userByPhone(phone: string): User | undefined {
    return this.db.prepare("SELECT * FROM users WHERE phone = ?").get(phone) as User | undefined;
  }
  user(id: number): User {
    const u = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as User | undefined;
    if (!u) throw new Error(`user ${id} not found`);
    return u;
  }
  upsertUser(phone: string, now: number): User {
    this.db
      .prepare("INSERT INTO users (phone, created_at) VALUES (?, ?) ON CONFLICT(phone) DO NOTHING")
      .run(phone, now);
    return this.userByPhone(phone)!;
  }
  setUserName(id: number, name: string) {
    this.db.prepare("UPDATE users SET name = ? WHERE id = ?").run(name, id);
  }
  setUserWallet(id: number, pubkey: string, encSecret: string) {
    this.db.prepare("UPDATE users SET pubkey = ?, enc_secret = ? WHERE id = ?").run(pubkey, encSecret, id);
  }
  setActiveTrip(userId: number, tripId: number) {
    this.db.prepare("UPDATE users SET active_trip_id = ? WHERE id = ?").run(tripId, userId);
  }

  // ---- trips
  createTrip(name: string, code: string, organizerId: number, now: number): Trip {
    const r = this.db
      .prepare("INSERT INTO trips (name, code, organizer_id, created_at) VALUES (?, ?, ?, ?)")
      .run(name, code, organizerId, now);
    return this.trip(Number(r.lastInsertRowid));
  }
  trip(id: number): Trip {
    const t = this.db.prepare("SELECT * FROM trips WHERE id = ?").get(id) as Trip | undefined;
    if (!t) throw new Error(`trip ${id} not found`);
    return t;
  }
  tripByCode(code: string): Trip | undefined {
    return this.db.prepare("SELECT * FROM trips WHERE code = ?").get(code.toUpperCase()) as Trip | undefined;
  }
  allTrips(): Trip[] {
    return this.db.prepare("SELECT * FROM trips ORDER BY id").all() as Trip[];
  }
  tripsFor(userId: number): Trip[] {
    return this.db
      .prepare("SELECT t.* FROM trips t JOIN members m ON m.trip_id = t.id WHERE m.user_id = ? ORDER BY t.created_at DESC")
      .all(userId) as Trip[];
  }
  markSettleRequested(tripId: number, now: number) {
    this.db.prepare("UPDATE trips SET settle_requested_at = ? WHERE id = ?").run(now, tripId);
  }
  lastPaymentNudge(tripId: number, userId: number): number | null {
    const r = this.db.prepare("SELECT at FROM payment_nudges WHERE trip_id = ? AND user_id = ?").get(tripId, userId) as
      | { at: number }
      | undefined;
    return r?.at ?? null;
  }
  setPaymentNudge(tripId: number, userId: number, now: number) {
    this.db
      .prepare(
        "INSERT INTO payment_nudges (trip_id, user_id, at) VALUES (?, ?, ?) ON CONFLICT(trip_id, user_id) DO UPDATE SET at = excluded.at",
      )
      .run(tripId, userId, now);
  }
  deleteExpense(expenseId: number) {
    this.db.prepare("UPDATE expenses SET status = 'deleted' WHERE id = ?").run(expenseId);
  }
  lastExpenseBy(payerId: number, tripId: number): Expense | undefined {
    return this.db
      .prepare("SELECT * FROM expenses WHERE payer_id = ? AND trip_id = ? AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1")
      .get(payerId, tripId) as Expense | undefined;
  }

  addMember(tripId: number, userId: number, now: number) {
    this.db
      .prepare("INSERT OR IGNORE INTO members (trip_id, user_id, joined_at) VALUES (?, ?, ?)")
      .run(tripId, userId, now);
  }
  isMember(tripId: number, userId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM members WHERE trip_id = ? AND user_id = ?").get(tripId, userId);
  }
  members(tripId: number): User[] {
    return this.db
      .prepare(
        "SELECT u.* FROM users u JOIN members m ON m.user_id = u.id WHERE m.trip_id = ? ORDER BY m.joined_at, u.id",
      )
      .all(tripId) as User[];
  }

  // ---- expenses & shares
  createExpense(
    e: Pick<Expense, "trip_id" | "payer_id" | "description" | "total_cents" | "has_receipt" | "receipt_json">,
    now: number,
  ): Expense {
    const r = this.db
      .prepare(
        `INSERT INTO expenses (trip_id, payer_id, description, total_cents, has_receipt, receipt_json, status, created_at, receipt_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      )
      .run(e.trip_id, e.payer_id, e.description, e.total_cents, e.has_receipt, e.receipt_json, now, e.has_receipt ? now : null);
    return this.expense(Number(r.lastInsertRowid));
  }
  expense(id: number): Expense {
    const e = this.db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as Expense | undefined;
    if (!e) throw new Error(`expense ${id} not found`);
    return e;
  }
  expenses(tripId: number): Expense[] {
    return this.db
      .prepare("SELECT * FROM expenses WHERE trip_id = ? AND status = 'active' ORDER BY created_at, id")
      .all(tripId) as Expense[];
  }
  attachReceipt(expenseId: number, receiptJson: string | null, now: number) {
    this.db
      .prepare("UPDATE expenses SET has_receipt = 1, receipt_json = COALESCE(?, receipt_json), receipt_at = ? WHERE id = ?")
      .run(receiptJson, now, expenseId);
  }
  setShare(expenseId: number, userId: number, cents: number, status: ShareStatus, now: number) {
    this.db
      .prepare(
        `INSERT INTO shares (expense_id, user_id, cents, status, decided_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(expense_id, user_id) DO UPDATE SET cents = excluded.cents, status = excluded.status,
           decided_at = excluded.decided_at, dispute_reason = NULL, notified_at = NULL, reminded_at = NULL`,
      )
      .run(expenseId, userId, cents, status, status === "pending" ? null : now);
  }
  shares(expenseId: number): Share[] {
    return this.db.prepare("SELECT * FROM shares WHERE expense_id = ? ORDER BY user_id").all(expenseId) as Share[];
  }
  share(expenseId: number, userId: number): Share | undefined {
    return this.db
      .prepare("SELECT * FROM shares WHERE expense_id = ? AND user_id = ?")
      .get(expenseId, userId) as Share | undefined;
  }
  decideShare(expenseId: number, userId: number, status: ShareStatus, reason: string | null, now: number) {
    this.db
      .prepare("UPDATE shares SET status = ?, dispute_reason = ?, decided_at = ? WHERE expense_id = ? AND user_id = ?")
      .run(status, reason, now, expenseId, userId);
  }
  markNotified(expenseId: number, userId: number, now: number) {
    this.db.prepare("UPDATE shares SET notified_at = ? WHERE expense_id = ? AND user_id = ?").run(now, expenseId, userId);
  }
  markReminded(expenseId: number, userId: number, now: number) {
    this.db.prepare("UPDATE shares SET reminded_at = ? WHERE expense_id = ? AND user_id = ?").run(now, expenseId, userId);
  }
  /** Shares a user still has to approve or dispute, oldest first. Excludes their own expenses. */
  pendingSharesFor(userId: number, tripId: number): (Share & { expense: Expense })[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM shares s JOIN expenses e ON e.id = s.expense_id
         WHERE s.user_id = ? AND e.trip_id = ? AND e.status = 'active' AND s.status = 'pending' AND e.payer_id != s.user_id
         ORDER BY COALESCE(s.notified_at, e.created_at), e.id`,
      )
      .all(userId, tripId) as Share[];
    return rows.map((s) => ({ ...s, expense: this.expense(s.expense_id) }));
  }
  /** All pending, non-payer shares across trips (for the background job). */
  allPendingShares(): (Share & { expense: Expense })[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM shares s JOIN expenses e ON e.id = s.expense_id
         WHERE e.status = 'active' AND s.status = 'pending' AND e.payer_id != s.user_id`,
      )
      .all() as Share[];
    return rows.map((s) => ({ ...s, expense: this.expense(s.expense_id) }));
  }
  /** Most recently approved share (not their own expense), so DISPUTE works after an auto-approve. */
  lastApprovedShareFor(userId: number, tripId: number): (Share & { expense: Expense }) | undefined {
    const s = this.db
      .prepare(
        `SELECT s.* FROM shares s JOIN expenses e ON e.id = s.expense_id
         WHERE s.user_id = ? AND e.trip_id = ? AND e.status = 'active' AND s.status = 'approved' AND e.payer_id != s.user_id
         ORDER BY s.decided_at DESC, e.id DESC LIMIT 1`,
      )
      .get(userId, tripId) as Share | undefined;
    return s ? { ...s, expense: this.expense(s.expense_id) } : undefined;
  }
  /** The payer's most recent expense that has an open dispute. */
  disputedExpenseFor(payerId: number, tripId: number): Expense | undefined {
    return this.db
      .prepare(
        `SELECT e.* FROM expenses e WHERE e.payer_id = ? AND e.trip_id = ? AND e.status = 'active'
         AND EXISTS (SELECT 1 FROM shares s WHERE s.expense_id = e.id AND s.status = 'disputed')
         ORDER BY e.created_at DESC, e.id DESC LIMIT 1`,
      )
      .get(payerId, tripId) as Expense | undefined;
  }

  // ---- transfers
  recordTransfer(t: Omit<Transfer, "id">): Transfer {
    const r = this.db
      .prepare(
        "INSERT INTO transfers (trip_id, from_id, to_id, cents, tx_sig, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.trip_id, t.from_id, t.to_id, t.cents, t.tx_sig, t.status, t.created_at);
    return { ...t, id: Number(r.lastInsertRowid) };
  }
  transfers(tripId: number): Transfer[] {
    return this.db
      .prepare("SELECT * FROM transfers WHERE trip_id = ? AND status = 'sent' ORDER BY created_at, id")
      .all(tripId) as Transfer[];
  }

  // ---- conversation state (one open question per user)
  setPending(userId: number, kind: string, payload: unknown, now: number) {
    this.db
      .prepare(
        `INSERT INTO pending (user_id, kind, payload, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET kind = excluded.kind, payload = excluded.payload, created_at = excluded.created_at`,
      )
      .run(userId, kind, JSON.stringify(payload), now);
  }
  getPending<T = unknown>(userId: number): { kind: string; payload: T } | undefined {
    const row = this.db.prepare("SELECT * FROM pending WHERE user_id = ?").get(userId) as Pending | undefined;
    return row ? { kind: row.kind, payload: JSON.parse(row.payload) as T } : undefined;
  }
  clearPending(userId: number) {
    this.db.prepare("DELETE FROM pending WHERE user_id = ?").run(userId);
  }
}
