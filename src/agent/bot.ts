import type { AI, InterpretContext, SplitSpec } from "../ai/types.js";
import { heuristicAmount, heuristicTripName } from "../ai/heuristic.js";
import type { Expense, Store, Trip, User } from "../ledger/db.js";
import { breakdownFor, pairwise, tripLedger } from "../ledger/settle.js";
import { type Receipt, receiptLooksConsistent, splitEven, splitItems } from "../ledger/split.js";
import type { Inbound, Messenger } from "../messaging/types.js";
import type { Chain } from "../solana/chain.js";
import { viewerToken } from "../web/viewer.js";
import { fmt, listNames, money, shortDate, titleCase } from "./format.js";

export interface BotConfig {
  botName: string;
  publicUrl: string;
  botPhone: string;
  startingBalanceCents: number;
  reminderGapMs: number;
  /** Signs per-person trip-page links; any string, falls back to a fixed dev value. */
  linkSecret?: string;
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
  | { kind: "awaiting_trip_name" }
  /** In several trips and the message didn't say which: hold it until they pick. */
  | { kind: "awaiting_trip_pick"; options: number[]; suggested: number }
  | { kind: "awaiting_reason"; amountCents: number; split: SplitSpec }
  | { kind: "awaiting_amount"; description: string | null; split: SplitSpec; hasPhoto: boolean }
  | { kind: "awaiting_split_mode"; receipt: Receipt; description: string }
  | { kind: "awaiting_items"; receipt: Receipt; description: string }
  | { kind: "awaiting_receipt"; expenseId: number };

const EVERYONE: SplitSpec = { mode: "everyone", names: [], includeSender: true };
const REPLY_HINT = "Reply DISPUTE + reason if that's wrong.";

export class Tab {
  private readonly store: Store;
  private readonly messenger: Messenger;
  private readonly ai: AI;
  private readonly chain: Chain;
  private readonly cfg: BotConfig;
  private readonly now: () => number;
  private paying = new Set<number>();
  /** Messages (possibly with photos) parked while we ask "which trip?", keyed by user id. */
  private held = new Map<number, Inbound>();

  constructor(deps: BotDeps) {
    this.store = deps.store;
    this.messenger = deps.messenger;
    this.ai = deps.ai;
    this.chain = deps.chain;
    this.cfg = deps.config;
    this.now = deps.now ?? Date.now;
  }

  // ------------------------------------------------------------------ entry points

  /** One message at a time per person, so a quick double-text can't race the pending state. */
  private queues = new Map<string, Promise<void>>();

  async handle(msg: Inbound): Promise<void> {
    const prev = this.queues.get(msg.phone) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(() => this.handleNow(msg));
    this.queues.set(msg.phone, run);
    try {
      await run;
    } finally {
      if (this.queues.get(msg.phone) === run) this.queues.delete(msg.phone);
    }
  }

  private async handleNow(msg: Inbound, tripOverride?: Trip): Promise<void> {
    const user = this.store.upsertUser(msg.phone, this.now());
    let text = msg.text.trim();
    let cmd = text.toUpperCase().replace(/[.!?]+$/, "");

    const join = cmd.match(/^JOIN\s*([A-Z0-9]{4,10})$/);
    if (join) return this.joinTrip(user, join[1]!);

    // Fast paths for the documented commands; anything looser goes through the model below.
    const newTrip =
      text.match(/^(?:new|start|create|open|make)\s+(?:a\s+|another\s+)?(?:new\s+)?(?:trip|tab)\s*(?:to|for|:|-)?\s*(.*)$/i) ??
      text.match(/^(?:new|start|create|open|make)\s+(?:a\s+|another\s+)?(?:new\s+)?(.+?)\s+(?:trip|tab)[.!]*$/i) ??
      text.match(/^(?:trip|tab)\s*:\s*(.+)$/i);
    if (newTrip) {
      const raw = newTrip[1]!.trim();
      return this.startTripFromIntent(user, /^(new|another|a|the|our|my)?$/i.test(raw) ? null : raw);
    }

    const rename = text.match(/^(?:call me|my name is|i'?m|im|rename me(?: to)?|name:?)\s+([A-Za-z][\w'-]*(?:\s+[A-Za-z][\w'-]*)?)[.!]*$/i);
    if (rename) {
      const name = titleCase(rename[1]!).slice(0, 30);
      this.store.setUserName(user.id, name);
      this.store.clearPending(user.id);
      return this.say(user, `Got it, I'll call you ${name} from now on.`);
    }

    const pending = this.store.getPending<PendingState>(user.id);
    if (pending && (await this.continuePending(user, { kind: pending.kind, ...(pending.payload as object) } as PendingState, msg))) {
      return;
    }

    const open = this.store.openTripsFor(user.id);
    if (!open.length) {
      // Not in a trip yet: the only useful thing they can mean is "start one", so let the model
      // read casual phrasings ("i am going on a new trip to florida") before giving up.
      const intent = text ? await this.ai.interpret(text, this.ctx(user, undefined, false)) : null;
      if (intent?.kind === "new_trip") return this.startTripFromIntent(user, intent.tripName);
      const closed = this.store.tripsFor(user.id).length > 0;
      return this.say(
        user,
        closed
          ? `All your trips are closed. Text "new trip <name>" to start another, or tap an invite link a friend sent you.`
          : `Hi! I'm ${this.cfg.botName}. I split trip expenses so nobody has to chase anyone. ` +
              `Text "new trip <name>" to start one, or tap the invite link a friend sent you.`,
      );
    }
    if (!user.name) {
      // Enrolled from the web invite but our greeting never reached them: whatever they just
      // sent is a hello, not an answer. Greet now and ask properly.
      return this.enroll(user, tripOverride ?? open[0]!);
    }

    // Which trip? One open trip: that one. Several: a trip named in the message wins ("$80 gas,
    // florida"); otherwise commands fall back to the trip they used last, and expenses get asked.
    const closeCmd = text.match(/^close\s+(?:the\s+|my\s+)?(.*?)\s*(?:trips?|tabs?)?\s*(anyways?|regardless)?[.!]*$/i);
    const closeAll = closeCmd ? /^(?:all|every|everything|both)\b/i.test(closeCmd[1] ?? "") : false;
    const named = tripOverride ? undefined : this.matchTrip(open, closeCmd ? (closeAll ? "" : (closeCmd[1] ?? "")) : text);
    if (named === "ambiguous") {
      return this.say(user, `That could be ${listNames(open.map((t) => t.name), "or")}. Which one?`);
    }
    if (named) {
      text = named.text;
      cmd = text.toUpperCase().replace(/[.!?]+$/, "");
    }
    const fresh = this.store.user(user.id);
    const trip = named?.trip ?? tripOverride ?? open.find((t) => t.id === fresh.active_trip_id) ?? open.at(-1)!;
    const needsPick = !named && !tripOverride && open.length > 1;
    if (fresh.active_trip_id !== trip.id) this.store.setActiveTrip(user.id, trip.id);

    if (closeCmd) return this.closeTrips(user, closeAll ? open : [trip], open, { force: Boolean(closeCmd[2]) });

    if (/^(YES|Y|YEP|YEAH|OK|OKAY|APPROVE|APPROVED|👍)$/.test(cmd)) return this.approve(user, this.tripWithDisputeAgainst(user, open) ?? trip);
    const dispute = text.match(/^dispute\b[\s:,-]*(.*)$/is);
    if (dispute) return this.dispute(user, named ? [trip] : open, dispute[1]!.trim());
    if (cmd === "WHY") return this.why(user, trip);
    if (/^(SETTLE|SETTLE UP)$/.test(cmd)) return this.settle(user, trip);
    if (cmd === "PAY") return this.pay(user, trip);
    if (/^(BALANCE|BALANCES|TOTAL|TOTALS|MY TOTAL|RUNNING TOTAL|STATUS)$/.test(cmd)) {
      return needsPick ? this.balanceAll(user, open) : this.balance(user, trip);
    }
    if (cmd === "UNDO") return this.undo(user, named ? [trip] : open);
    if (/^(LINK|TRIP|INVITE)$/.test(cmd)) return this.link(user, trip);
    if (/^(TRIPS|MY TRIPS)$/.test(cmd)) return this.listTrips(user, open);
    if (cmd === "HELP") return this.help(user);
    const remind = text.match(/^(?:remind|nudge|poke)\s+(.+?)[.!]*$/i);
    if (remind) return this.remind(user, trip, remind[1]!);
    const agree = text.match(/^(?:agree|agreed|fine|fair|fair enough|ok(?:ay)? fine|drop (?:it|them|him|her)|take (\w+) off|remove (\w+))[.!]*$/i);
    const disputedTrip = agree ? this.tripWithDisputeBy(user, open) : undefined;
    if (agree && disputedTrip) return this.agreeDispute(user, disputedTrip, agree[1] ?? agree[2]);

    if (msg.images.length) {
      // A payer fixing a dispute with a photo shouldn't be asked which trip; the dispute knows.
      const fixing = this.tripWithDisputeBy(user, open);
      if (fixing && !named) return this.receiptExpense(user, fixing, msg);
      if (needsPick) return this.askTripPick(user, open, trip, msg, true);
      return this.receiptExpense(user, trip, msg);
    }

    const intent = await this.ai.interpret(text, this.ctx(user, trip, false));
    switch (intent.kind) {
      case "expense":
        if (needsPick) return this.askTripPick(user, open, trip, { ...msg, text }, false);
        return this.textExpense(user, trip, intent.amountCents, intent.description, intent.split);
      case "why":
        return this.why(user, trip);
      case "balance":
        return needsPick ? this.balanceAll(user, open) : this.balance(user, trip);
      case "settle":
        return this.settle(user, trip);
      case "pay":
        return this.pay(user, trip);
      case "help":
        return this.help(user);
      case "new_trip":
        return this.startTripFromIntent(user, intent.tripName);
      case "close_trip": {
        if (intent.all) return this.closeTrips(user, open, open, intent);
        const target = intent.tripName ? this.matchTrip(open, intent.tripName) : undefined;
        if (target === "ambiguous") return this.say(user, `Which one: ${listNames(open.map((t) => t.name), "or")}?`);
        return this.closeTrips(user, [target?.trip ?? trip], open, intent);
      }
      case "dispute":
        return this.dispute(user, named ? [trip] : open, intent.reason ?? "");
      case "remind":
        return this.remind(user, trip, intent.names.join(", "));
      case "rename": {
        if (!intent.name) return this.say(user, `What should I call you? e.g. "call me PJ".`);
        const name = titleCase(intent.name).slice(0, 30);
        this.store.setUserName(user.id, name);
        return this.say(user, `Got it, I'll call you ${name} from now on.`);
      }
      case "undo":
        return this.undo(user, named ? [trip] : open);
      case "link":
        return this.link(user, trip);
      case "agree": {
        const t = this.tripWithDisputeBy(user, open);
        if (t) return this.agreeDispute(user, t);
        return this.say(user, `Nothing's waiting on you right now. Text TOTAL to see where you stand.`);
      }
      default:
        return this.say(user, `Not sure what you mean. Text me a receipt or something like "paid $40 for snacks". Text HELP for more.`);
    }
  }

  // ------------------------------------------------------------------ several trips at once

  private static readonly TRIP_STOPWORDS = new Set(["the", "our", "and", "with", "trip", "tab", "for"]);

  private tripKeywords(trip: Trip): string[] {
    return trip.name
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((w) => w.length >= 3 && !Tab.TRIP_STOPWORDS.has(w));
  }

  /**
   * Does the text name one of these trips? Returns the trip and the text with the trip words
   * removed ("$80 gas, florida" -> "$80 gas"), "ambiguous" if it names several, else undefined.
   */
  private matchTrip(trips: Trip[], text: string): { trip: Trip; text: string } | "ambiguous" | undefined {
    if (!text) return undefined;
    const hits = trips
      .map((trip) => {
        const words = this.tripKeywords(trip);
        const hit = words.filter((w) => new RegExp(`\\b${escapeRe(w)}\\b`, "i").test(text));
        return { trip, hit, score: words.length ? hit.length / words.length : 0 };
      })
      .filter((h) => h.hit.length);
    if (!hits.length) {
      const exact = trips.filter((t) => t.name.toLowerCase() === text.toLowerCase() || t.code.toLowerCase() === text.toLowerCase());
      return exact.length === 1 ? { trip: exact[0]!, text: "" } : exact.length ? "ambiguous" : undefined;
    }
    const best = Math.max(...hits.map((h) => h.score));
    const top = hits.filter((h) => h.score === best);
    if (top.length > 1) return "ambiguous";
    const { trip, hit } = top[0]!;
    let stripped = text;
    for (const w of hit) {
      stripped = stripped.replace(new RegExp(`\\b(?:(?:for|on|in|to|at)\\s+)?(?:the\\s+|our\\s+)?${escapeRe(w)}(?:\\s+(?:trip|tab))?\\b`, "i"), " ");
    }
    stripped = stripped
      .replace(/\s+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "")
      .trim();
    return { trip, text: stripped };
  }

  private async askTripPick(user: User, open: Trip[], suggested: Trip, msg: Inbound, photo: boolean) {
    this.held.set(user.id, msg);
    this.store.setPending(user.id, "awaiting_trip_pick", { options: open.map((t) => t.id), suggested: suggested.id }, this.now());
    const names = open.map((t, i) => `${i + 1}) ${shortTripName(t)}`).join("  ");
    await this.say(
      user,
      `Which trip is that ${photo ? "receipt" : ""}for? ${names}\nReply the name or number, or YES for ${shortTripName(suggested)}. ` +
        `(Tip: say it inline next time, like "$80 gas, ${shortTripName(suggested).toLowerCase()}".)`,
    );
  }

  /** The open trip where someone disputed one of this payer's charges, if any. */
  private tripWithDisputeBy(payer: User, open: Trip[]): Trip | undefined {
    return open.find((t) => this.store.disputedExpenseFor(payer.id, t.id));
  }

  /** The open trip where this person has an open dispute of their own (for YES to take it back). */
  private tripWithDisputeAgainst(user: User, open: Trip[]): Trip | undefined {
    return open.find((t) => this.store.disputedSharesFor(user.id, t.id).length);
  }

  private async listTrips(user: User, open: Trip[]) {
    const lines = open.map((t) => `• ${t.name}: ${this.runningLine(user.id, t.id)}`);
    await this.say(user, `Your open trips:\n${lines.join("\n")}\nName the trip when you log something ("$80 gas, ${shortTripName(open[0]!).toLowerCase()}"), or "close <trip>" when one's over.`);
  }

  private async balanceAll(user: User, open: Trip[]) {
    const lines = open.map((t) => `${t.name}: ${this.runningLine(user.id, t.id)}`);
    await this.say(user, `${lines.join("\n")}\nReply TOTAL + trip name for the full picture, or PAY + trip name to settle one.`);
    for (const t of open) this.store.setPaymentNudge(t.id, user.id, this.now());
  }

  /** Close one or more trips. Unsettled ones are refused unless `force` ("close florida anyway"). */
  /**
   * Close one or more trips. With balances open: refused by default; `settledOutside` ("we sorted
   * it out") records the outstanding amounts as paid outside Tab so the books close clean; `force`
   * ("close it anyway") closes with the balances left showing.
   */
  private async closeTrips(user: User, targets: Trip[], open: Trip[], how: { force?: boolean; settledOutside?: boolean }) {
    const now = this.now();
    const plans = new Map(targets.map((t) => [t.id, tripLedger(this.store, t.id).plan]));
    const blocked = how.force || how.settledOutside ? [] : targets.filter((t) => plans.get(t.id)!.length);
    const closing = targets.filter((t) => !blocked.includes(t));
    const settledLines: string[] = [];

    for (const trip of closing) {
      const plan = plans.get(trip.id)!;
      if (how.settledOutside && plan.length) {
        for (const d of plan) {
          this.store.recordTransfer({ trip_id: trip.id, from_id: d.from, to_id: d.to, cents: d.cents, tx_sig: null, status: "sent", created_at: now });
          settledLines.push(`${this.nameOf(this.store.user(d.from))} → ${this.nameOf(this.store.user(d.to))} ${fmt(d.cents)}`);
        }
      }
      this.store.closeTrip(trip.id, now);
      const note = plan.length ? (how.settledOutside ? " and marked what was left as settled outside Tab" : " (with balances still open)") : "";
      for (const m of this.store.members(trip.id)) {
        if (m.id === user.id) continue;
        await this.say(m, `${this.nameOf(user)} closed ${trip.name}${note}. Everything's still on the trip page: ${this.pageLink(trip, m)}`);
      }
    }

    const parts: string[] = [];
    if (closing.length) {
      const pages = closing.length === 1 && targets.length === 1 ? ` The trip page stays up: ${this.pageLink(closing[0]!, user)}` : "";
      parts.push(`Closed ${listNames(closing.map((t) => t.name))}.${pages}`);
      if (settledLines.length) parts.push(`Marked as settled outside Tab: ${settledLines.join(", ")}.`);
    }
    if (blocked.length) {
      const detail = blocked
        .map((t) => `${t.name} isn't settled yet: ${listNames(plans.get(t.id)!.map((d) => `${this.nameOf(this.store.user(d.from))} owes ${this.nameOf(this.store.user(d.to))} ${fmt(d.cents)}`))}.`)
        .join("\n");
      const again = blocked.length === 1 && targets.length === 1 ? `close ${shortTripName(blocked[0]!).toLowerCase()} anyway` : "close all anyway";
      parts.push(`${detail}\nReply SETTLE to sort it out, "we settled it ourselves" if the money already changed hands, or "${again}" to close ${blocked.length === 1 ? "it" : "them"} as is.`);
    }
    const left = open.filter((t) => !closing.includes(t));
    if (closing.length && left.length) parts.push(`You're still in ${listNames(left.map((t) => t.name))}.`);
    await this.say(user, parts.join("\n"));
  }

  /** "new trip" with no name: ask for one instead of creating "Our Trip". */
  private async startTripFromIntent(user: User, tripName: string | null) {
    if (tripName?.trim()) return this.createTrip(user, tripName);
    this.store.setPending(user.id, "awaiting_trip_name", {}, this.now());
    return this.say(user, `Nice! What should I call the trip? (e.g. "Florida" or "Beach Week")`);
  }

  /**
   * Web invite flow: someone typed their number on /j/:code.
   *
   * The person is enrolled in the trip either way. The first text to a number we have never
   * messaged can be refused by the platform right after registration, so we retry once and,
   * if it still fails, hand back the line they can text instead of failing the request.
   */
  async joinByPhone(phone: string, code: string): Promise<{ line?: string }> {
    const line = await this.messenger.register(phone);
    const user = this.store.upsertUser(phone, this.now());
    const trip = this.store.tripByCode(code);
    if (!trip) throw new Error(`no trip with code ${code}`);

    const wasMember = this.store.isMember(trip.id, user.id);
    this.store.setActiveTrip(user.id, trip.id);
    if (!wasMember) this.store.addMember(trip.id, user.id, this.now());

    // Don't hold the web request: the messenger may spend a couple of minutes getting the
    // first text through. The name question is only queued once a greeting actually lands.
    void this.greetAfterWebJoin(user, trip, wasMember).catch((err) =>
      console.error(`[join] couldn't text ${phone}; they can text JOIN ${trip.code} to ${line ?? "the bot"}:`, (err as Error).message),
    );
    return { line };
  }

  /** Start page: register a brand-new organizer so their first text reaches us. Returns their Tab number. */
  async startByPhone(phone: string): Promise<{ line?: string }> {
    const line = await this.messenger.register(phone);
    this.store.upsertUser(phone, this.now());
    return { line };
  }

  private async greetAfterWebJoin(user: User, trip: Trip, wasMember: boolean) {
    await this.ensureWallet(user);
    const fresh = this.store.user(user.id);
    if (fresh.name || this.store.getPending(user.id)) return; // they texted in first; handle() greeted them
    await this.enroll(fresh, trip);
    if (!wasMember && fresh.name) await this.announceJoin(fresh, trip);
  }

  // ------------------------------------------------------------------ trips & onboarding

  private async createTrip(user: User, rawName: string) {
    const base = titleCase(rawName.replace(/[^\w\s'-]/g, "").trim()).slice(0, 40) || "Our";
    const name = /\btrip$/i.test(base) ? base : `${base} Trip`;
    const code = this.newCode(base);
    const trip = this.store.createTrip(name, code, user.id, this.now());
    this.store.addMember(trip.id, user.id, this.now());
    this.store.setActiveTrip(user.id, trip.id);

    const others = this.store.openTripsFor(user.id).filter((t) => t.id !== trip.id);
    await this.say(user, `${name} created! Friends can text ${this.cfg.botName} "JOIN ${trip.code}", or forward them this link:`);
    await this.say(user, this.inviteLink(trip));
    if (others.length) {
      await this.say(user, `You're also in ${listNames(others.map((t) => t.name))}, so name the trip when you log something, like "$80 gas, ${shortTripName(trip).toLowerCase()}". Text "close <trip>" when one is over.`);
    }
    if (!user.name) {
      this.store.setPending(user.id, "awaiting_name", {}, this.now());
      await this.say(user, "And what should I call you?");
    }
    await this.ensureWallet(user);
  }

  private async joinTrip(user: User, code: string) {
    const trip = this.store.tripByCode(code);
    if (!trip) return this.say(user, `I couldn't find a trip with code ${code.toUpperCase()}. Double-check the invite?`);
    const wasMember = this.store.isMember(trip.id, user.id);
    await this.enroll(user, trip);
    if (!wasMember && user.name) await this.announceJoin(user, trip);
    await this.ensureWallet(user);
  }

  /**
   * Make the trip the person's active one, add them if needed (safe to repeat), and greet them.
   * A person without a name is asked for one, but only once the greeting has actually been
   * delivered; otherwise their next text (usually "hi") would be taken as the answer.
   */
  private async enroll(user: User, trip: Trip): Promise<void> {
    const organizer = this.store.user(trip.organizer_id);
    this.store.setActiveTrip(user.id, trip.id);
    const already = this.store.isMember(trip.id, user.id);
    if (!already) this.store.addMember(trip.id, user.id, this.now());
    const withWho = organizer.id === user.id ? "" : ` with ${organizer.name ?? "your friends"}`;

    if (!user.name) {
      await this.say(user, `You're in ${trip.name}${withWho}! What should I call you?`);
      this.store.setPending(user.id, "awaiting_name", {}, this.now());
      return;
    }
    await this.say(user, already ? `You're already in ${trip.name} 👍` : `You're in ${trip.name}${withWho}! ${this.welcomeTip()}`);
  }

  private async announceJoin(user: User, trip: Trip) {
    if (trip.organizer_id === user.id) return;
    const organizer = this.store.user(trip.organizer_id);
    await this.say(organizer, `${this.store.user(user.id).name} joined ${trip.name} 🎉`);
  }

  private welcomeTip() {
    return `Text me receipts or things like "paid $40 for snacks." I'll keep track; text TOTAL any time to see where you stand.`;
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
      case "awaiting_trip_pick": {
        const options = p.options.map((id) => this.store.trip(id)).filter((t) => !t.closed_at);
        const heldMsg = this.held.get(user.id);
        const n = Number(text);
        const byNumber = Number.isInteger(n) && n >= 1 && n <= options.length ? options[n - 1] : undefined;
        const byYes = /^(yes|y|yep|yeah|ok|okay|sure|👍)[.!]*$/i.test(text) ? options.find((t) => t.id === p.suggested) : undefined;
        // A brand-new expense or photo replaces the parked one rather than answering the question.
        const replaces = !byNumber && !byYes && (msg.images.length > 0 || heuristicAmount(text) !== null);
        const byName = !byNumber && !byYes && !replaces && text ? this.matchTrip(options, text) : undefined;
        const chosen = byNumber ?? byYes ?? (byName && byName !== "ambiguous" ? byName.trip : undefined);
        if (chosen) {
          this.store.clearPending(user.id);
          this.held.delete(user.id);
          this.store.setActiveTrip(user.id, chosen.id);
          if (!heldMsg) {
            await this.say(user, `Got it, ${chosen.name}. Send that again and I'll log it there.`);
            return true;
          }
          await this.handleNow(heldMsg, chosen);
          return true;
        }
        if (/^(no|nah|nevermind|never mind|cancel|stop|forget it)\b/i.test(text)) {
          this.store.clearPending(user.id);
          this.held.delete(user.id);
          await this.say(user, "Okay, dropped it.");
          return true;
        }
        if (replaces) {
          this.store.clearPending(user.id);
          this.held.delete(user.id);
          return false;
        }
        await this.say(user, `Which trip: ${listNames(options.map((t) => shortTripName(t)), "or")}?`);
        return true;
      }

      case "awaiting_trip_name": {
        if (!text || msg.images.length) return false;
        this.store.clearPending(user.id);
        if (/^(no|nah|nevermind|never mind|cancel|stop)\b/i.test(text)) {
          await this.say(user, `No problem. Text "new trip <name>" whenever you're ready.`);
          return true;
        }
        const name = heuristicTripName(text) ?? text.replace(/^(?:call it|name it|it'?s|let'?s say|how about)\s+/i, "");
        if (!name) return false;
        await this.createTrip(user, name);
        return true;
      }

      case "awaiting_name": {
        if (!text) return false;
        if (/^(hi+|hey+|hello+|yo+|sup|hola|howdy|ok(ay)?|yes|yeah|yep|hi there|hey there|what'?s up|test(ing)?)[\s!.?]*$/i.test(text)) {
          await this.say(user, `Hi! 👋 What should I call you? (Just your first name is fine.)`);
          return true;
        }
        const name = parseName(text);
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
        // "What was the $2 for?" -> "$2400 for flights, split evenly": take the corrected amount and split.
        const restated = await this.ai.interpret(text, this.ctx(user, trip, false));
        const corrected = restated.kind === "expense" && restated.amountCents !== null ? restated : null;
        const amount = corrected?.amountCents ?? p.amountCents;
        const split = corrected && corrected.split.mode !== "unspecified" ? corrected.split : p.split;
        const description = corrected?.description ?? this.cleanDescription(text) ?? "Expense";
        await this.logExpense(user, trip, description, amount, split, null, false);
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
        this.store.setShare(e.id, userId, cents, "approved", now);
      }
      return e;
    });

    const others = [...split.keys()].filter((id) => id !== payer.id).map((id) => this.store.user(id));
    const told = !others.length ? "Nobody else is on this one." : `I've told ${listNames(others.map((u) => this.nameOf(u)))}.`;
    await this.say(payer, `Logged to ${trip.name}: ${expense.description} ${fmt(totalCents)} · ${this.splitSummary(split, byItem)}${note}. ${told}`);

    for (const u of others) {
      await this.say(u, `${this.nameOf(payer)} logged ${expense.description} ${fmt(totalCents)}${this.onTrip(u, trip)} · your share ${fmt(split.get(u.id)!)}. ${REPLY_HINT}`);
      this.store.markNotified(expense.id, u.id, now);
      this.store.setPaymentNudge(trip.id, u.id, now);
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
    const disputers = this.store.shares(expense.id).filter((s) => s.user_id !== payer.id && s.status === "disputed");
    this.store.tx(() => {
      this.store.attachReceipt(expense.id, receipt ? JSON.stringify(receipt) : null, now);
      for (const s of disputers) this.store.decideShare(expense.id, s.user_id, "approved", null, now);
    });
    const mismatch =
      receipt && receipt.total_cents !== expense.total_cents
        ? ` Heads up: the receipt says ${fmt(receipt.total_cents)} but the expense is ${fmt(expense.total_cents)}. Reply UNDO and log it again if that's wrong.`
        : "";
    const settled = disputers.length ? ` ${listNames(disputers.map((s) => this.nameOf(this.store.user(s.user_id))))} ${disputers.length === 1 ? "is" : "are"} counted again.` : "";
    await this.say(payer, `Receipt added to ${expense.description}.${settled}${mismatch}`);
    for (const s of disputers) {
      await this.say(
        this.store.user(s.user_id),
        `${this.nameOf(payer)} added a receipt for ${expense.description} ${fmt(expense.total_cents)}, so your ${fmt(s.cents)} counts again. ` +
          `Reply DISPUTE + reason if it's still wrong.`,
      );
      this.store.markNotified(expense.id, s.user_id, now);
    }
  }

  // ------------------------------------------------------------------ approvals

  private async approve(user: User, trip: Trip) {
    const disputed = this.store.disputedSharesFor(user.id, trip.id)[0];
    if (disputed) {
      this.store.decideShare(disputed.expense_id, user.id, "approved", null, this.now());
      const payer = this.store.user(disputed.expense.payer_id);
      this.store.clearPending(payer.id);
      await this.say(user, `Counting ${disputed.expense.description} ${fmt(disputed.cents)} again.`);
      return this.say(payer, `${this.nameOf(user)} is fine with ${disputed.expense.description} after all. No receipt needed.`);
    }
    await this.say(user, `No need to approve anything: shares count as soon as they're logged. ${REPLY_HINT}`);
  }

  private async dispute(user: User, trips: Trip[], reason: string) {
    const candidates = trips
      .flatMap((trip) => this.store.approvedSharesFor(user.id, trip.id).map((s) => ({ ...s, trip })))
      .sort((a, b) => b.expense.created_at - a.expense.created_at || b.expense.id - a.expense.id);
    const words = reason.toLowerCase().match(/[a-z]{3,}/g) ?? [];
    const target = candidates.find((s) => words.some((w) => s.expense.description.toLowerCase().includes(w))) ?? candidates[0];
    if (!target) return this.say(user, "There's nothing of yours to dispute right now.");
    const trip = target.trip;
    this.store.decideShare(target.expense_id, user.id, "disputed", reason || null, this.now());
    const payer = this.store.user(target.expense.payer_id);
    await this.say(
      user,
      `Disputed ${target.expense.description}${this.onTrip(user, trip)}. Your ${fmt(target.cents)} won't count until ${this.nameOf(payer)} adds a receipt or takes you off it. ` +
        `(Reply YES if you change your mind.)`,
    );
    this.store.setPending(payer.id, "awaiting_receipt", { expenseId: target.expense_id }, this.now());
    await this.say(
      payer,
      `${this.nameOf(user)} disputed ${target.expense.description}${this.onTrip(payer, trip)} (${fmt(target.cents)})${reason ? `: "${reason}"` : ""}. ` +
        `Send me a receipt photo, reply AGREE to take ${this.nameOf(user)} off it, or UNDO to remove the whole thing.`,
    );
  }

  /** The payer accepts a dispute: the disputer comes off the expense and the rest is re-split. */
  private async agreeDispute(payer: User, trip: Trip, named?: string) {
    const expense = this.store.disputedExpenseFor(payer.id, trip.id)!;
    const shares = this.store.shares(expense.id);
    const disputed = shares.filter((s) => s.status === "disputed");
    let who = disputed[0];
    if (named && !/^(them|him|her|it)$/i.test(named)) {
      const match = this.resolveNames([named], this.store.members(trip.id), payer);
      if ("error" in match) return this.say(payer, match.error);
      who = disputed.find((s) => s.user_id === match.ids[0]) ?? who;
    }
    if (!who) return this.say(payer, "Nobody has disputed anything of yours right now.");
    if (disputed.length > 1 && !named) {
      return this.say(payer, `${listNames(disputed.map((s) => this.nameOf(this.store.user(s.user_id))))} disputed ${expense.description}. Reply "remove <name>" for whoever's right.`);
    }

    const remaining = shares.filter((s) => s.user_id !== who!.user_id);
    if (!remaining.length) return this.say(payer, `That would leave nobody on ${expense.description}. Reply UNDO to remove it instead.`);
    const even = remaining.every((s) => Math.abs(s.cents - remaining[0]!.cents) <= 1) && Math.abs(who.cents - remaining[0]!.cents) <= 1;
    const topUp = splitEven(who.cents, remaining.map((s) => s.user_id));
    const next = new Map(remaining.map((s) => [s.user_id, even ? 0 : s.cents + (topUp.get(s.user_id) ?? 0)]));
    if (even) for (const [id, c] of splitEven(expense.total_cents, remaining.map((s) => s.user_id))) next.set(id, c);

    const now = this.now();
    this.store.tx(() => {
      this.store.removeShare(expense.id, who!.user_id);
      for (const s of remaining) this.store.setShare(expense.id, s.user_id, next.get(s.user_id)!, "approved", now);
    });
    this.store.clearPending(payer.id);

    const dropped = this.store.user(who.user_id);
    await this.say(payer, `Done. ${this.nameOf(dropped)} is off ${expense.description}; it's now ${this.splitSummary(next, !even)}.`);
    await this.say(dropped, `${this.nameOf(payer)} agreed: you're off ${expense.description}${this.onTrip(dropped, trip)}.`);
    for (const s of remaining) {
      if (s.user_id === payer.id) continue;
      const u = this.store.user(s.user_id);
      await this.say(
        u,
        `${this.nameOf(dropped)} came off ${expense.description} ${fmt(expense.total_cents)}, so your share is now ${fmt(next.get(s.user_id)!)}. ${REPLY_HINT}`,
      );
      this.store.setPaymentNudge(trip.id, u.id, now);
    }
  }

  private async undo(user: User, trips: Trip[]) {
    const e = this.store.lastExpenseByAcross(user.id, trips.map((t) => t.id));
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
      const status = l.share.status === "disputed" ? "you disputed it (not counted)" : "counted";
      return `• ${fmt(l.share.cents)} to ${this.nameOf(this.store.user(l.payerId))}: ${e.description} (${how}), ${proof}, ${status}`;
    });
    const paidTotal = paid.reduce((a, t) => a + t.cents, 0);
    const paidLine = paidTotal ? `\nYou've already paid ${fmt(paidTotal)}.` : "";
    await this.say(user, `You owe ${fmt(total)} total:\n${bullets.join("\n")}${paidLine}`);
  }

  private async balance(user: User, trip: Trip) {
    const { net } = tripLedger(this.store, trip.id);
    const mine = net.get(user.id) ?? 0;
    const bottom = mine < 0 ? `Net: you owe ${fmt(-mine)}. Reply PAY to settle up or WHY for every line.` : mine > 0 ? `Net: you're owed ${fmt(mine)}.` : `Net: all square 🎉`;
    await this.say(user, `${trip.name} running total: ${this.runningLine(user.id, trip.id)}.\n${bottom}\nEverything, line by line: ${this.pageLink(trip, user)}`);
    this.store.setPaymentNudge(trip.id, user.id, this.now());
  }

  /** "remind Jake" / "remind everyone": text people who owe the sender their running total. */
  private async remind(user: User, trip: Trip, who: string) {
    const members = this.store.members(trip.id);
    const names = who.split(/\s*(?:,|&|\band\b)\s*/i).filter(Boolean);
    const ids = this.resolveNames(names, members, user);
    if ("error" in ids) return this.say(user, ids.error);
    const targets = ids.ids.filter((id) => id !== user.id);
    if (!targets.length) return this.say(user, `Who should I remind? e.g. "remind Jake" or "remind everyone".`);

    const now = this.now();
    const reminded: string[] = [];
    const square: string[] = [];
    const { net } = tripLedger(this.store, trip.id);
    for (const id of targets) {
      // Someone who is square overall (paid via the routed settle plan) owes nobody, whatever
      // the pairwise lines say; otherwise cite the pairwise amount, capped at their net debt.
      const theirNet = net.get(id) ?? 0;
      const pair = pairwise(this.store, trip.id, id).find((p) => p.other === user.id)?.cents ?? 0;
      const owesMe = theirNet < 0 ? Math.min(pair, -theirNet) : 0;
      if (owesMe <= 0) {
        square.push(this.nameOf(this.store.user(id)));
        continue;
      }
      const target = this.store.user(id);
      await this.say(
        target,
        `👋 ${this.nameOf(user)} asked me to remind you: you owe ${this.nameOf(user)} ${fmt(owesMe)} for ${trip.name}. ` +
          `Running total: ${this.runningLine(id, trip.id)}. Reply PAY to settle up or WHY for every line.`,
      );
      this.store.setPaymentNudge(trip.id, id, now);
      reminded.push(`${this.nameOf(target)} (${fmt(owesMe)})`);
    }
    const parts: string[] = [];
    if (reminded.length) parts.push(`Reminded ${listNames(reminded)}.`);
    if (square.length) parts.push(`${listNames(square)} ${square.length === 1 ? "doesn't" : "don't"} owe you anything right now.`);
    await this.say(user, parts.join(" "));
  }

  /**
   * "you owe Amit $20.00 and Priya $32.00 · Sam owes you $7.50". Settle-up payments are routed
   * for fewest transfers, so once someone is square overall the pairwise view can still show
   * offsetting lines; say "all square" in that case rather than confuse them.
   */
  private runningLine(userId: number, tripId: number): string {
    if ((tripLedger(this.store, tripId).net.get(userId) ?? 0) === 0) return "you're all square";
    const pairs = pairwise(this.store, tripId, userId);
    const owe = pairs.filter((p) => p.cents > 0).map((p) => `${this.nameOf(this.store.user(p.other))} ${fmt(p.cents)}`);
    const owed = pairs.filter((p) => p.cents < 0).map((p) => `${this.nameOf(this.store.user(p.other))} owes you ${fmt(-p.cents)}`);
    const parts: string[] = [];
    if (owe.length) parts.push(`you owe ${listNames(owe)}`);
    if (owed.length) parts.push(listNames(owed));
    return parts.length ? parts.join(" · ") : "you're all square";
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
      await this.say(
        u,
        `You owe ${this.debtList(plan.filter((d) => d.from === id))} for ${trip.name}.\n` +
          `• Reply PAY to send USDC from your ${this.cfg.botName} wallet\n• Reply WHY for the breakdown.`,
      );
      this.store.setPaymentNudge(trip.id, id, now);
    }
    for (const id of creditors) {
      const owed = plan.filter((d) => d.to === id);
      await this.say(
        this.store.user(id),
        `Settling up ${trip.name}: ${listNames(owed.map((d) => `${this.nameOf(this.store.user(d.from))} owes you ${fmt(d.cents)}`))}. ` +
          `I'll text you when they pay. Full breakdown: ${this.pageLink(trip, this.store.user(id))}`,
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
      if (!tripLedger(this.store, trip.id).plan.length) {
        await this.say(user, `That squares up ${trip.name}. Text "close ${shortTripName(trip).toLowerCase()}" when you're done with it.`);
      }
      for (const s of sent) {
        await this.say(s.to, `💸 ${this.nameOf(me)} paid you ${fmt(s.cents)} USDC for ${trip.name}. ${this.chain.explorerUrl(s.sig)}`);
      }
    } finally {
      this.paying.delete(user.id);
    }
  }

  private async link(user: User, trip: Trip) {
    await this.say(user, `${trip.name} · invite code JOIN ${trip.code}. Invite link, then the trip page:`);
    await this.say(user, this.inviteLink(trip));
    await this.say(user, this.pageLink(trip, user));
  }

  private async help(user: User) {
    await this.say(
      user,
      [
        `Here's what I can do:`,
        `• Send a receipt photo (add "everyone", "me, Jake and Sam", or "by item")`,
        `• "paid $40 for snacks" logs an expense; everyone's share counts right away`,
        `• DISPUTE + reason if a share is wrong (YES takes it back)`,
        `• TOTAL shows your running total per person, WHY explains every line`,
        `• SETTLE works out who pays whom, PAY sends it`,
        `• UNDO removes your last expense, LINK shares the invite`,
        `• "remind Jake" (or "remind everyone") texts them what they owe you`,
        `• "call me Sam" fixes your name`,
        `• In more than one trip? Add the name: "$80 gas, florida". TRIPS lists them, "close florida" ends one`,
      ].join("\n"),
    );
  }

  // ------------------------------------------------------------------ background jobs

  /** Auto-approvals and reminders. Called on an interval. */
  async runJobs(): Promise<void> {
    const now = this.now();

    // One running-total reminder a day (reminderGapMs) for anyone who owes, and only if they
    // haven't been told their total in that window already (expense texts, TOTAL, "remind X").
    for (const trip of this.store.allTrips()) {
      if (trip.closed_at) continue;
      const { net } = tripLedger(this.store, trip.id);
      for (const [userId, cents] of net) {
        if (cents >= 0) continue;
        const last = this.store.lastPaymentNudge(trip.id, userId) ?? trip.created_at;
        if (now - last < this.cfg.reminderGapMs) continue;
        await this.say(
          this.store.user(userId),
          `Daily total for ${trip.name}: ${this.runningLine(userId, trip.id)}. Net: you owe ${fmt(-cents)}. ` +
            `Reply PAY to settle up, WHY for every line, or DISPUTE + reason if something's off.`,
        );
        this.store.setPaymentNudge(trip.id, userId, now);
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private async say(user: User, text: string) {
    await this.messenger.send(user.phone, text);
  }

  /** " on Nyc Trip" when the recipient is in more than one open trip, else "". */
  private onTrip(user: User, trip: Trip): string {
    return this.store.openTripsFor(user.id).length > 1 ? ` on ${trip.name}` : "";
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

  private ctx(user: User, trip: Trip | undefined, hasImage: boolean): InterpretContext {
    return {
      senderName: this.nameOf(user),
      memberNames: trip ? this.store.members(trip.id).map((m) => this.nameOf(m)) : [],
      hasImage,
      tripName: trip?.name ?? null,
      openTripNames: this.store.openTripsFor(user.id).map((t) => t.name),
      openDispute: trip ? Boolean(this.store.disputedExpenseFor(user.id, trip.id)) : false,
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

  /** Trip page. With a viewer, the link opens already on that person (see web/viewer.ts). */
  pageLink(trip: Trip, viewer?: User): string {
    const base = `${this.cfg.publicUrl}/t/${trip.code}`;
    return viewer ? `${base}?me=${viewerToken(this.cfg.linkSecret || "dev-link-secret", trip.id, viewer.id)}` : base;
  }
}

/** "Florida Trip" -> "Florida" for prompts like 'say "$80 gas, florida"'. */
function shortTripName(trip: Trip): string {
  return trip.name.replace(/\s+trip$/i, "") || trip.name;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Dan", "I'm Dan", "Dan is here", "it's kunal!" -> "Dan" / "Kunal". Keeps a two-word name like "Mary Ann". */
export function parseName(text: string): string {
  const words = text
    .replace(/^(?:hi+|hey+|hello+|yo+)[,!\s]+/i, "")
    .replace(/^(?:i'?m|im|call me|it'?s|its|this is|my name is|my name'?s|name'?s)\s+/i, "")
    .replace(/[^\p{L}\p{N}'\- ]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  const stop = /^(is|here|from|and|the|this|it|lol|haha|btw|nice|hey|hi|hello|joining|again|yo|was|am)$/i;
  const kept: string[] = [];
  for (const w of words) {
    if (stop.test(w)) break;
    kept.push(w);
    if (kept.length === 2) break;
  }
  return titleCase(kept.join(" ") || words[0] || "").slice(0, 30);
}
