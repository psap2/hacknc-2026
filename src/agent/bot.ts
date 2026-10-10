import type { AI, InterpretContext, SplitSpec } from "../ai/types.js";
import type { Expense, Store, Trip, User } from "../ledger/db.js";
import { breakdownFor, tripLedger } from "../ledger/settle.js";
import { type Receipt, receiptLooksConsistent, splitEven, splitItems } from "../ledger/split.js";
import type { Inbound, Messenger } from "../messaging/types.js";
import type { Chain } from "../solana/chain.js";
import { fmt, listNames, money, plural, shortDate, titleCase } from "./format.js";

export interface BotConfig {
  botName: string;
  publicUrl: string;
  botPhone: string;
  startingBalanceCents: number;
  autoApproveMs: number;
  reminderGapMs: number;
}

export interface BotDeps {
  store: Store;
  messenger: Messenger;
  ai: AI;
  chain: Chain;
  config: BotConfig;
  now?: () => number;
}

/** Conversation state: the one question Tab is waiting on for each person. */
type PendingState =
  | { kind: "awaiting_name" }
  | { kind: "awaiting_reason"; amountCents: number; split: SplitSpec }
  | { kind: "awaiting_amount"; description: string | null; split: SplitSpec; hasPhoto: boolean }
  | { kind: "awaiting_split_mode"; receipt: Receipt; description: string }
  | { kind: "awaiting_items"; receipt: Receipt; description: string }
  | { kind: "awaiting_receipt"; expenseId: number };

const EVERYONE: SplitSpec = { mode: "everyone", names: [], includeSender: true };
const REPLY_HINT = "Reply YES, DISPUTE + reason, or WHY.";

export class Tab {
  private readonly store: Store;
  private readonly messenger: Messenger;
  private readonly ai: AI;
  private readonly chain: Chain;
  private readonly cfg: BotConfig;
  private readonly now: () => number;
  private paying = new Set<number>();

  constructor(deps: BotDeps) {
    this.store = deps.store;
    this.messenger = deps.messenger;
    this.ai = deps.ai;
    this.chain = deps.chain;
    this.cfg = deps.config;
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------ entry points

  async handle(msg: Inbound): Promise<void> {
    const user = this.store.upsertUser(msg.phone, this.now());
    const text = msg.text.trim();
    const cmd = text.toUpperCase().replace(/[.!?]+$/, "");

    const join = cmd.match(/^JOIN\s+([A-Z0-9]{4,10})$/);
    if (join) return this.joinTrip(user, join[1]!);

    const newTrip = text.match(/^(?:new|start|create)\s+(?:a\s+)?trip\s*:?\s*(.+)$/i);
    if (newTrip) return this.createTrip(user, newTrip[1]!);

    const pending = this.store.getPending<PendingState>(user.id);
    if (pending && (await this.continuePending(user, { kind: pending.kind, ...(pending.payload as object) } as PendingState, msg))) {
      return;
    }

    const trip = this.activeTrip(user);
    if (!trip) {
      return this.say(
        user,
        `Hi! I'm ${this.cfg.botName}. I split trip expenses so nobody has to chase anyone. ` +
          `Text "new trip <name>" to start one, or tap the invite link a friend sent you.`,
      );
    }

    if (/^(YES|Y|YEP|YEAH|OK|OKAY|APPROVE|APPROVED|👍)$/.test(cmd)) return this.approve(user, trip);
    const dispute = text.match(/^dispute\b[\s:,-]*(.*)$/is);
    if (dispute) return this.dispute(user, trip, dispute[1]!.trim());
    if (cmd === "WHY") return this.why(user, trip);
    if (/^(SETTLE|SETTLE UP)$/.test(cmd)) return this.settle(user, trip);
    if (cmd === "PAY") return this.pay(user, trip);
    if (/^(BALANCE|BALANCES)$/.test(cmd)) return this.balance(user, trip);
    if (cmd === "UNDO") return this.undo(user, trip);
    if (/^(LINK|TRIP|INVITE)$/.test(cmd)) return this.link(user, trip);
    if (cmd === "HELP") return this.help(user);

    if (msg.images.length) return this.receiptExpense(user, trip, msg);

    const intent = await this.ai.interpret(text, this.ctx(user, trip, false));
    switch (intent.kind) {
      case "expense":
        return this.textExpense(user, trip, intent.amountCents, intent.description, intent.split);
      case "why":
        return this.why(user, trip);
      case "balance":
        return this.balance(user, trip);
      case "settle":
        return this.settle(user, trip);
      case "pay":
        return this.pay(user, trip);
      case "help":
        return this.help(user);
      default:
        return this.say(user, `Not sure what you mean. Text me a receipt or something like "paid $40 for snacks". Text HELP for more.`);
    }
  }

  /** Web invite flow: someone typed their number on /j/:code. */
  async joinByPhone(phone: string, code: string): Promise<void> {
    await this.messenger.register(phone);
    const user = this.store.upsertUser(phone, this.now());
    await this.joinTrip(user, code);
  }

  // ------------------------------------------------------------------ trips & onboarding

  private async createTrip(user: User, rawName: string) {
    const base = titleCase(rawName.replace(/[^\w\s'-]/g, "").trim()).slice(0, 40) || "Our";
    const name = /\btrip$/i.test(base) ? base : `${base} Trip`;
    const code = this.newCode(base);
    const trip = this.store.createTrip(name, code, user.id, this.now());
    this.store.addMember(trip.id, user.id, this.now());
    this.store.setActiveTrip(user.id, trip.id);

    await this.say(user, `${name} created! Paste this in your group chat:\n\n"Join our ${base} tab 👉 text ${this.cfg.botName} "JOIN ${trip.code}" or tap ${this.inviteLink(trip)}"`);
    if (!user.name) {
      this.store.setPending(user.id, "awaiting_name", {}, this.now());
      await this.say(user, "And what should I call you?");
    }
    await this.ensureWallet(user);
  }

  private async joinTrip(user: User, code: string) {
    const trip = this.store.tripByCode(code);
    if (!trip) return this.say(user, `I couldn't find a trip with code ${code.toUpperCase()}. Double-check the invite?`);
    const organizer = this.store.user(trip.organizer_id);
    this.store.setActiveTrip(user.id, trip.id);

    if (this.store.isMember(trip.id, user.id)) {
      return this.say(user, `You're already in ${trip.name} 👍`);
    }
    this.store.addMember(trip.id, user.id, this.now());

    const withWho = organizer.id === user.id ? "" : ` with ${organizer.name ?? "your friends"}`;
    if (!user.name) {
      this.store.setPending(user.id, "awaiting_name", {}, this.now());
      await this.say(user, `You're in ${trip.name}${withWho}! What should I call you?`);
    } else {
      await this.say(user, `You're in ${trip.name}${withWho}! ${this.welcomeTip()}`);
      await this.announceJoin(user, trip);
    }
    await this.ensureWallet(user);
  }

  private async announceJoin(user: User, trip: Trip) {
    if (trip.organizer_id === user.id) return;
    const organizer = this.store.user(trip.organizer_id);
    await this.say(organizer, `${this.store.user(user.id).name} joined ${trip.name} 🎉`);
  }

  private welcomeTip() {
    return `Text me receipts or things like "paid $40 for snacks." I'll keep track.`;
  }

  /** Every member gets a custodial devnet wallet with test USDC. Nobody sees the crypto side. */
  private async ensureWallet(user: User) {
    const fresh = this.store.user(user.id);
    if (fresh.pubkey) return;
    const { pubkey, encSecret } = this.chain.createWallet();
    this.store.setUserWallet(user.id, pubkey, encSecret);
    try {
      await this.chain.fund(pubkey, this.cfg.startingBalanceCents);
    } catch (err) {
      console.error(`[chain] funding ${pubkey} failed:`, err);
    }
  }

  // ------------------------------------------------------------------ multi-step conversations

  /** Returns true if the message was consumed by the open question. */
  private async continuePending(user: User, p: PendingState, msg: Inbound): Promise<boolean> {
    const text = msg.text.trim();
    const trip = this.activeTrip(user);

    switch (p.kind) {
      case "awaiting_name": {
        if (!text) return false;
        const name = titleCase(text.replace(/^(i'?m|im|call me|it'?s|my name is)\s+/i, "").split(/\s+/).slice(0, 2).join(" ")).slice(0, 30);
        this.store.setUserName(user.id, name);
        this.store.clearPending(user.id);
        await this.say(user, `Got it, ${name}. ${this.welcomeTip()}`);
        if (trip) await this.announceJoin(user, trip);
        return true;
      }

      case "awaiting_receipt": {
        if (!msg.images.length || !trip) {
          this.store.clearPending(user.id);
          return false;
        }
        this.store.clearPending(user.id);
        await this.attachReceipt(user, trip, this.store.expense(p.expenseId), msg);
        return true;
      }

      case "awaiting_reason": {
        if (!trip) return false;
        this.store.clearPending(user.id);
        if (msg.images.length) {
          const receipt = await this.readReceipt(msg);
          const description = this.cleanDescription(text) ?? receipt?.merchant ?? "Expense";
          await this.logExpense(user, trip, description, receipt?.total_cents ?? p.amountCents, p.split, receipt, true);
          return true;
        }
        if (!text) return false;
        await this.logExpense(user, trip, this.cleanDescription(text) ?? "Expense", p.amountCents, p.split, null, false);
        return true;
      }

      case "awaiting_amount": {
        if (!trip) return false;
        const amount = (await this.ai.interpret(text, this.ctx(user, trip, false)));
        const cents = amount.kind === "expense" ? amount.amountCents : null;
        if (cents === null) {
          await this.say(user, `How much was it? e.g. "$42.50"`);
          return true;
        }
        this.store.clearPending(user.id);
        if (!p.description) {
          this.store.setPending(user.id, "awaiting_reason", { amountCents: cents, split: p.split }, this.now());
          await this.say(user, `What was the ${money(cents)} for? A receipt photo helps.`);
          return true;
        }
        await this.logExpense(user, trip, p.description, cents, p.split, null, p.hasPhoto);
        return true;
      }

      case "awaiting_split_mode": {
        if (!trip || !text) return false;
        const ctx = this.ctx(user, trip, true);
        const intent = await this.ai.interpret(text, ctx);
        const split = intent.kind === "expense" ? intent.split : null;
        if (split?.mode === "by_item" || /\bitem/i.test(text)) {
          this.store.clearPending(user.id);
          return this.askItems(user, p.receipt, p.description).then(() => true);
        }
        if (!split || split.mode === "unspecified") {
          await this.say(user, `Split evenly with everyone, or by item? You can also name people, e.g. "me, Jake and Sam".`);
          return true;
        }
        this.store.clearPending(user.id);
        await this.logExpense(user, trip, p.description, p.receipt.total_cents, split, p.receipt, true);
        return true;
      }

      case "awaiting_items": {
        if (!trip || !text) return false;
        const ctx = this.ctx(user, trip, true);
        const assignment = await this.ai.assignItems(text, p.receipt.items, ctx);
        if (!assignment) {
          await this.say(user, `Sorry, I didn't catch that. Try something like "1,3 Sam; 2 Jake; rest everyone".`);
          return true;
        }
        const members = this.store.members(trip.id);
        const perItem: number[][] = [];
        for (const a of assignment) {
          const ids = this.resolveNames(a.names, members, user);
          if ("error" in ids) {
            await this.say(user, ids.error);
            return true;
          }
          perItem[a.item] = ids.ids;
        }
        this.store.clearPending(user.id);
        const split = splitItems(p.receipt.items, perItem, p.receipt.total_cents);
        await this.createExpense(user, trip, p.description, p.receipt.total_cents, split, p.receipt, true, true);
        return true;
      }
    }
  }

  // ------------------------------------------------------------------ logging expenses

  private async receiptExpense(user: User, trip: Trip, msg: Inbound) {
    // A payer with a disputed expense who sends a bare photo is fixing that dispute.
    const disputed = this.store.disputedExpenseFor(user.id, trip.id);
    const intent = msg.text ? await this.ai.interpret(msg.text, this.ctx(user, trip, true)) : null;
    const captionDescribesNew = intent?.kind === "expense" && (intent.amountCents !== null || intent.description !== null);
    if (disputed && !captionDescribesNew) return this.attachReceipt(user, trip, disputed, msg);

    const split = intent?.kind === "expense" ? intent.split : { ...EVERYONE, mode: "unspecified" as const };
    const typedAmount = intent?.kind === "expense" ? intent.amountCents : null;
    const typedDescription = intent?.kind === "expense" ? intent.description : null;

    const receipt = await this.readReceipt(msg);
    if (!receipt) {
      if (typedAmount !== null) {
        return this.logExpense(user, trip, typedDescription ?? "Expense", typedAmount, split, null, true);
      }
      this.store.setPending(user.id, "awaiting_amount", { description: typedDescription, split, hasPhoto: true }, this.now());
      return this.say(user, "I couldn't read that receipt 😅 What was the total?");
    }

    const description = typedDescription ?? titleCase(receipt.merchant || "Receipt");
    if (split.mode === "by_item") return this.askItems(user, receipt, description);
    if (split.mode === "unspecified" && receipt.items.length > 1) {
      this.store.setPending(user.id, "awaiting_split_mode", { receipt, description }, this.now());
      return this.say(
        user,
        `Got it: ${description} ${fmt(receipt.total_cents)}. Split evenly with everyone, or by item? ` +
          `You can also name people, e.g. "me, Jake and Sam".`,
      );
    }
    const note =
      typedAmount !== null && typedAmount !== receipt.total_cents
        ? ` (you said ${fmt(typedAmount)}, the receipt says ${fmt(receipt.total_cents)}, so I used the receipt)`
        : "";
    return this.logExpense(user, trip, description, receipt.total_cents, split, receipt, true, note);
  }

  private async textExpense(user: User, trip: Trip, amountCents: number | null, description: string | null, split: SplitSpec) {
    if (amountCents === null) {
      this.store.setPending(user.id, "awaiting_amount", { description, split, hasPhoto: false }, this.now());
      return this.say(user, `How much was ${description ? description.toLowerCase() : "it"}?`);
    }
    if (!description) {
      this.store.setPending(user.id, "awaiting_reason", { amountCents, split }, this.now());
      return this.say(user, `What was the ${money(amountCents)} for? A receipt photo helps.`);
    }
    return this.logExpense(user, trip, description, amountCents, split, null, false);
  }

  private async askItems(user: User, receipt: Receipt, description: string) {
    this.store.setPending(user.id, "awaiting_items", { receipt, description }, this.now());
    const lines = receipt.items.map((it, i) => `${i + 1}) ${it.name} ${fmt(it.price_cents)}`);
    const extra = receipt.total_cents - receipt.items.reduce((a, it) => a + it.price_cents, 0);
    if (extra) lines.push(`(+${fmt(extra)} tax/tip, split in proportion)`);
    await this.say(user, `${description} ${fmt(receipt.total_cents)}:\n${lines.join("\n")}\n\nWho had what? e.g. "1,3 Sam; 2 Jake; rest everyone"`);
  }

  /** Even-style split (everyone / only / except). */
  private async logExpense(
    payer: User,
    trip: Trip,
    description: string,
    totalCents: number,
    spec: SplitSpec,
    receipt: Receipt | null,
    hasReceipt: boolean,
    note = "",
  ) {
    const members = this.store.members(trip.id);
    const ids = this.resolveSplit(spec.mode === "unspecified" || spec.mode === "by_item" ? EVERYONE : spec, members, payer);
    if ("error" in ids) return this.say(payer, ids.error);
    const split = splitEven(totalCents, ids.ids);
    return this.createExpense(payer, trip, description, totalCents, split, receipt, hasReceipt, false, note);
  }

  private async createExpense(
    payer: User,
    trip: Trip,
    description: string,
    totalCents: number,
    split: Map<number, number>,
    receipt: Receipt | null,
    hasReceipt: boolean,
    byItem: boolean,
    note = "",
  ) {
    const now = this.now();
    const expense = this.store.tx(() => {
      const e = this.store.createExpense(
        {
          trip_id: trip.id,
          payer_id: payer.id,
          description: titleCase(description),
          total_cents: totalCents,
          has_receipt: hasReceipt ? 1 : 0,
          receipt_json: receipt ? JSON.stringify(receipt) : null,
        },
        now,
      );
      for (const [userId, cents] of split) {
        this.store.setShare(e.id, userId, cents, userId === payer.id ? "approved" : "pending", now);
      }
      return e;
    });

    const others = [...split.keys()].filter((id) => id !== payer.id).map((id) => this.store.user(id));
    const receiptTag = !hasReceipt
      ? "⚠️ no receipt"
      : receipt && receiptLooksConsistent(receipt) && receipt.total_cents === totalCents
        ? "🧾 receipt matched"
        : "🧾 receipt";
    const ask = !others.length
      ? "Nobody else is on this one."
      : hasReceipt
        ? `I've asked ${listNames(others.map((u) => this.nameOf(u)))} to OK their share${others.length > 1 ? "s" : ""}.`
        : "Everyone has to approve it themselves.";
    await this.say(
      payer,
      `Logged to ${trip.name}: ${expense.description} ${fmt(totalCents)} · ${this.splitSummary(split, byItem)} · ${receiptTag}${note}. ${ask}`,
    );

    const tag = hasReceipt ? "🧾 receipt" : "⚠️ no receipt";
    for (const u of others) {
      await this.say(
        u,
        `${this.nameOf(payer)} logged ${expense.description} ${fmt(totalCents)} (${tag}). Your share: ${fmt(split.get(u.id)!)}. ${REPLY_HINT}`,
      );
      this.store.markNotified(expense.id, u.id, now);
    }
  }

  private splitSummary(split: Map<number, number>, byItem: boolean): string {
    const amounts = [...split.values()];
    const n = amounts.length;
    if (!byItem && Math.max(...amounts) - Math.min(...amounts) <= 1) {
      const each = amounts[0]!;
      const exact = amounts.every((a) => a === each);
      return n === 1 ? "just you" : `split ${n} ways (${exact ? "" : "~"}${money(each)} each)`;
    }
    return `split by item: ${[...split].map(([id, c]) => `${this.nameOf(this.store.user(id))} ${money(c)}`).join(", ")}`;
  }

  private async attachReceipt(payer: User, trip: Trip, expense: Expense, msg: Inbound) {
    const receipt = await this.readReceipt(msg);
    const now = this.now();
    const shares = this.store.shares(expense.id).filter((s) => s.user_id !== payer.id);
    // Disputers hear about it first.
    shares.sort((a, b) => Number(b.status === "disputed") - Number(a.status === "disputed"));
    this.store.tx(() => {
      this.store.attachReceipt(expense.id, receipt ? JSON.stringify(receipt) : null, now);
      for (const s of shares) this.store.setShare(expense.id, s.user_id, s.cents, "pending", now);
    });
    const mismatch =
      receipt && receipt.total_cents !== expense.total_cents
        ? ` Heads up: the receipt says ${fmt(receipt.total_cents)} but the expense is ${fmt(expense.total_cents)}. Reply UNDO and log it again if that's wrong.`
        : "";
    await this.say(payer, `🧾 Receipt added to ${expense.description}. I've asked everyone to OK it again.${mismatch}`);
    for (const s of shares) {
      await this.say(
        this.store.user(s.user_id),
        `${this.nameOf(payer)} added a receipt for ${expense.description} ${fmt(expense.total_cents)}. Your share: ${fmt(s.cents)}. ${REPLY_HINT}`,
      );
      this.store.markNotified(expense.id, s.user_id, now);
    }
  }

  // ------------------------------------------------------------------ approvals

  private async approve(user: User, trip: Trip) {
    const queue = this.store.pendingSharesFor(user.id, trip.id);
    const first = queue[0];
    if (!first) return this.say(user, "Nothing is waiting for your OK 👍");
    this.store.decideShare(first.expense_id, user.id, "approved", null, this.now());
    const next = queue[1];
    const more = next
      ? ` Next: ${next.expense.description} ${fmt(next.cents)} (${this.nameOf(this.store.user(next.expense.payer_id))}). ${REPLY_HINT}`
      : "";
    await this.say(user, `✅ Approved${queue.length > 1 ? ` ${first.expense.description}` : ""}.${more}`);
  }

  private async dispute(user: User, trip: Trip, reason: string) {
    const target = this.store.pendingSharesFor(user.id, trip.id)[0] ?? this.store.lastApprovedShareFor(user.id, trip.id);
    if (!target) return this.say(user, "There's nothing of yours to dispute right now.");
    this.store.decideShare(target.expense_id, user.id, "disputed", reason || null, this.now());
    const payer = this.store.user(target.expense.payer_id);
    await this.say(
      user,
      `Disputed. I asked ${this.nameOf(payer)} for a receipt or a fix. Your ${fmt(target.cents)} won't count until it's sorted.`,
    );
    this.store.setPending(payer.id, "awaiting_receipt", { expenseId: target.expense_id }, this.now());
    await this.say(
      payer,
      `${this.nameOf(user)} disputed ${target.expense.description} (${fmt(target.cents)})${reason ? `: "${reason}"` : ""}. ` +
        `Send me a receipt photo, or reply UNDO to remove it.`,
    );
  }

  private async undo(user: User, trip: Trip) {
    const e = this.store.lastExpenseBy(user.id, trip.id);
    if (!e) return this.say(user, "You haven't logged anything I can undo.");
    const affected = this.store.shares(e.id).filter((s) => s.user_id !== user.id);
    this.store.deleteExpense(e.id);
    this.store.clearPending(user.id);
    await this.say(user, `🗑️ Removed ${e.description} ${fmt(e.total_cents)}.`);
    for (const s of affected) {
      await this.say(this.store.user(s.user_id), `${this.nameOf(user)} removed ${e.description} ${fmt(e.total_cents)}. You don't owe anything for it.`);
    }
  }

  // ------------------------------------------------------------------ explaining & settling

  private async why(user: User, trip: Trip) {
    const { lines, paid } = breakdownFor(this.store, trip.id, user.id);
    const { net } = tripLedger(this.store, trip.id);
    const counted = lines.filter((l) => l.share.status !== "disputed");
    if (!lines.length) {
      const owed = net.get(user.id) ?? 0;
      return this.say(user, owed > 0 ? `You don't owe anything. You're owed ${fmt(owed)} on ${trip.name}.` : `You don't owe anything on ${trip.name} 🎉`);
    }
    const total = counted.reduce((a, l) => a + l.share.cents, 0);
    const bullets = lines.map((l) => {
      const e = l.expense;
      const even = this.store.shares(e.id).every((s, _, all) => Math.abs(s.cents - all[0]!.cents) <= 1);
      const how = even ? `${money(e.total_cents)} ÷ ${l.splitCount}` : "by item";
      const proof = e.has_receipt
        ? `${e.receipt_at && e.receipt_at - e.created_at > 60_000 ? "receipt added" : "receipt"} ${shortDate(e.receipt_at ?? e.created_at)}`
        : `no receipt, ${shortDate(e.created_at)}`;
      const status =
        l.share.status === "approved" ? "you approved" : l.share.status === "pending" ? "still waiting on your OK" : "you disputed it (not counted)";
      return `• ${fmt(l.share.cents)} to ${this.nameOf(this.store.user(l.payerId))}: ${e.description} (${how}), ${proof}, ${status}`;
    });
    const paidTotal = paid.reduce((a, t) => a + t.cents, 0);
    const paidLine = paidTotal ? `\nYou've already paid ${fmt(paidTotal)}.` : "";
    await this.say(user, `You owe ${fmt(total)} total:\n${bullets.join("\n")}${paidLine}`);
  }

  private async balance(user: User, trip: Trip) {
    const { net, plan } = tripLedger(this.store, trip.id);
    const mine = net.get(user.id) ?? 0;
    const waiting = this.store.pendingSharesFor(user.id, trip.id).length;
    const debts = plan.filter((d) => d.from === user.id);
    let msg =
      mine < 0
        ? `You owe ${this.debtList(debts)} for ${trip.name}. Reply PAY to settle or WHY for the breakdown.`
        : mine > 0
          ? `You're owed ${fmt(mine)} on ${trip.name}.`
          : `You're all square on ${trip.name} 🎉`;
    if (waiting) msg += ` (${plural(waiting, "expense")} still waiting on your OK ${waiting === 1 ? "isn't" : "aren't"} counted yet.)`;
    await this.say(user, msg);
  }

  private debtList(debts: { to: number; cents: number }[]): string {
    return listNames(debts.map((d) => `${this.nameOf(this.store.user(d.to))} ${fmt(d.cents)}`));
  }

  private async settle(user: User, trip: Trip) {
    const { plan } = tripLedger(this.store, trip.id);
    const now = this.now();
    this.store.markSettleRequested(trip.id, now);
    if (!plan.length) return this.say(user, `Everyone's square on ${trip.name} 🎉`);

    const debtors = [...new Set(plan.map((d) => d.from))];
    const creditors = [...new Set(plan.map((d) => d.to))];
    for (const id of debtors) {
      const u = this.store.user(id);
      const waiting = this.store.pendingSharesFor(id, trip.id).length;
      const note = waiting ? `\n(${plural(waiting, "expense")} still waiting on your OK ${waiting === 1 ? "isn't" : "aren't"} included yet.)` : "";
      await this.say(
        u,
        `You owe ${this.debtList(plan.filter((d) => d.from === id))} for ${trip.name}.\n` +
          `• Reply PAY to send USDC from your ${this.cfg.botName} wallet\n• Reply WHY for the breakdown.${note}`,
      );
      this.store.setPaymentNudge(trip.id, id, now);
    }
    for (const id of creditors) {
      const owed = plan.filter((d) => d.to === id);
      await this.say(
        this.store.user(id),
        `Settling up ${trip.name}: ${listNames(owed.map((d) => `${this.nameOf(this.store.user(d.from))} owes you ${fmt(d.cents)}`))}. ` +
          `I'll text you when they pay. Full breakdown: ${this.pageLink(trip)}`,
      );
    }
    if (!debtors.includes(user.id) && !creditors.includes(user.id)) {
      await this.say(user, "Done. I texted everyone what they owe.");
    }
  }

  private async pay(user: User, trip: Trip) {
    if (this.paying.has(user.id)) return this.say(user, "Hang on, your last payment is still going through ⏳");
    this.paying.add(user.id);
    try {
      const debts = tripLedger(this.store, trip.id).plan.filter((d) => d.from === user.id);
      if (!debts.length) return await this.say(user, "You don't owe anything right now 🎉");
      await this.ensureWallet(user);
      const me = this.store.user(user.id);
      const total = debts.reduce((a, d) => a + d.cents, 0);
      const bal = await this.chain.balance(me.pubkey!);
      if (bal < total) {
        return await this.say(user, `Your ${this.cfg.botName} wallet only has ${fmt(bal)} USDC, but you owe ${fmt(total)}.`);
      }

      const sent: { to: User; cents: number; sig: string }[] = [];
      for (const d of debts) {
        const to = this.store.user(d.to);
        if (!to.pubkey) await this.ensureWallet(to);
        const toPub = this.store.user(d.to).pubkey!;
        try {
          const sig = await this.chain.transfer(me.enc_secret!, toPub, d.cents);
          this.store.recordTransfer({ trip_id: trip.id, from_id: me.id, to_id: to.id, cents: d.cents, tx_sig: sig, status: "sent", created_at: this.now() });
          sent.push({ to, cents: d.cents, sig });
        } catch (err) {
          console.error("[chain] transfer failed:", err);
          await this.say(user, `⚠️ Payment to ${this.nameOf(to)} failed. Nothing else was sent after it. Try PAY again in a minute.`);
          break;
        }
      }
      if (!sent.length) return;

      const sentTotal = sent.reduce((a, s) => a + s.cents, 0);
      const parts = sent.map((s) => `${this.nameOf(s.to)} ${money(s.cents)}`).join(", ");
      const links =
        sent.length === 1
          ? ` · view on Solana: ${this.chain.explorerUrl(sent[0]!.sig)}`
          : `\n${sent.map((s) => `${this.nameOf(s.to)}: ${this.chain.explorerUrl(s.sig)}`).join("\n")}`;
      await this.say(user, `✅ Sent ${fmt(sentTotal)} USDC: ${parts}${links}`);
      for (const s of sent) {
        await this.say(s.to, `💸 ${this.nameOf(me)} paid you ${fmt(s.cents)} USDC for ${trip.name}. ${this.chain.explorerUrl(s.sig)}`);
      }
    } finally {
      this.paying.delete(user.id);
    }
  }

  private async link(user: User, trip: Trip) {
    await this.say(user, `${trip.name}\nInvite friends: text ${this.cfg.botName} "JOIN ${trip.code}" or ${this.inviteLink(trip)}\nSee everything: ${this.pageLink(trip)}`);
  }

  private async help(user: User) {
    await this.say(
      user,
      [
        `Here's what I can do:`,
        `• Send a receipt photo (add "everyone", "me, Jake and Sam", or "by item")`,
        `• "paid $40 for snacks" logs an expense`,
        `• YES / DISPUTE + reason to approve or push back on your share`,
        `• WHY explains what you owe, BALANCE shows where you stand`,
        `• SETTLE works out who pays whom, PAY sends it`,
        `• UNDO removes your last expense, LINK shares the invite`,
      ].join("\n"),
    );
  }

  // ------------------------------------------------------------------ background jobs

  /** Auto-approvals and reminders. Called on an interval. */
  async runJobs(): Promise<void> {
    const now = this.now();

    // 1) Receipt-backed shares auto-approve after a grace period. No-receipt shares never do.
    for (const s of this.store.allPendingShares()) {
      if (!s.expense.has_receipt) continue;
      const since = Math.max(s.notified_at ?? s.expense.created_at, s.expense.receipt_at ?? 0);
      if (now - since < this.cfg.autoApproveMs) continue;
      this.store.decideShare(s.expense_id, s.user_id, "approved", null, now);
      await this.say(
        this.store.user(s.user_id),
        `✅ Auto-approved ${s.expense.description}: your ${fmt(s.cents)} share (receipt on file). Reply DISPUTE if that's wrong.`,
      );
    }

    // 2) Nudge people with approvals waiting.
    const byUserTrip = new Map<string, ReturnType<Store["allPendingShares"]>>();
    for (const s of this.store.allPendingShares()) {
      const last = s.reminded_at ?? s.notified_at ?? s.expense.created_at;
      if (now - last < this.cfg.reminderGapMs) continue;
      const key = `${s.user_id}:${s.expense.trip_id}`;
      byUserTrip.set(key, [...(byUserTrip.get(key) ?? []), s]);
    }
    for (const shares of byUserTrip.values()) {
      const items = shares.map((s) => `${s.expense.description} ${fmt(s.cents)} (${this.nameOf(this.store.user(s.expense.payer_id))})`);
      await this.say(
        this.store.user(shares[0]!.user_id),
        `Reminder: ${plural(shares.length, "expense")} ${shares.length === 1 ? "needs" : "need"} your OK: ${items.join("; ")}. Reply YES, DISPUTE, or WHY.`,
      );
      for (const s of shares) this.store.markReminded(s.expense_id, s.user_id, now);
    }

    // 3) After a settle-up, nudge anyone who still hasn't paid.
    for (const trip of this.store.allTrips()) {
      if (!trip.settle_requested_at) continue;
      const { plan } = tripLedger(this.store, trip.id);
      for (const debtor of new Set(plan.map((d) => d.from))) {
        const last = this.store.lastPaymentNudge(trip.id, debtor) ?? trip.settle_requested_at;
        if (now - last < this.cfg.reminderGapMs) continue;
        await this.say(
          this.store.user(debtor),
          `Reminder: you owe ${this.debtList(plan.filter((d) => d.from === debtor))} for ${trip.name}. Reply PAY to settle in one tap.`,
        );
        this.store.setPaymentNudge(trip.id, debtor, now);
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private async say(user: User, text: string) {
    await this.messenger.send(user.phone, text);
  }

  private nameOf(user: User): string {
    return this.store.user(user.id).name ?? `•••${user.phone.slice(-4)}`;
  }

  private activeTrip(user: User): Trip | undefined {
    const fresh = this.store.user(user.id);
    if (fresh.active_trip_id && this.store.isMember(fresh.active_trip_id, user.id)) return this.store.trip(fresh.active_trip_id);
    const latest = this.store.tripsFor(user.id)[0];
    if (latest) this.store.setActiveTrip(user.id, latest.id);
    return latest;
  }

  private ctx(user: User, trip: Trip, hasImage: boolean): InterpretContext {
    return {
      senderName: this.nameOf(user),
      memberNames: this.store.members(trip.id).map((m) => this.nameOf(m)),
      hasImage,
    };
  }

  private async readReceipt(msg: Inbound): Promise<Receipt | null> {
    const img = msg.images[0];
    if (!img) return null;
    try {
      return await this.ai.readReceipt(img);
    } catch (err) {
      console.error("[ai] receipt read failed:", err);
      return null;
    }
  }

  private cleanDescription(text: string): string | null {
    const s = text.replace(/^(it was|for|it's|its)\s+/i, "").split(/[,.;\n]/)[0]!.trim();
    return s ? titleCase(s).slice(0, 40) : null;
  }

  private resolveSplit(spec: SplitSpec, members: User[], payer: User): { ids: number[] } | { error: string } {
    const all = members.map((m) => m.id);
    if (spec.mode === "everyone") return { ids: all };
    const named = this.resolveNames(spec.names, members, payer);
    if ("error" in named) return named;
    if (spec.mode === "except") {
      const ids = all.filter((id) => !named.ids.includes(id) && (spec.includeSender || id !== payer.id));
      return ids.length ? { ids } : { error: "That leaves nobody to split with 🤔" };
    }
    const ids = new Set(named.ids);
    if (spec.includeSender) ids.add(payer.id);
    return { ids: all.filter((id) => ids.has(id)) };
  }

  private resolveNames(names: string[], members: User[], sender: User): { ids: number[] } | { error: string } {
    const ids: number[] = [];
    for (const raw of names) {
      const n = raw.trim().toLowerCase();
      if (["me", "i", "myself"].includes(n)) {
        ids.push(sender.id);
        continue;
      }
      if (["everyone", "all", "everybody"].includes(n)) {
        ids.push(...members.map((m) => m.id));
        continue;
      }
      const match =
        members.find((m) => this.nameOf(m).toLowerCase() === n) ??
        members.find((m) => this.nameOf(m).toLowerCase().startsWith(n) || n.startsWith(this.nameOf(m).toLowerCase()));
      if (!match) {
        return { error: `I don't know who "${raw}" is on this trip. Members: ${listNames(members.map((m) => this.nameOf(m)))}.` };
      }
      ids.push(match.id);
    }
    return { ids: [...new Set(ids)] };
  }

  private newCode(name: string): string {
    const letters = (name.toUpperCase().replace(/[^A-Z]/g, "") + "TRIP").slice(0, 4);
    for (;;) {
      const code = `${letters}${Math.floor(10 + Math.random() * 90)}`;
      if (!this.store.tripByCode(code)) return code;
    }
  }

  private inviteLink(trip: Trip): string {
    if (this.cfg.botPhone) return `sms:${this.cfg.botPhone}&body=JOIN%20${trip.code}`;
    return `${this.cfg.publicUrl}/j/${trip.code}`;
  }

  pageLink(trip: Trip): string {
    return `${this.cfg.publicUrl}/t/${trip.code}`;
  }
}
