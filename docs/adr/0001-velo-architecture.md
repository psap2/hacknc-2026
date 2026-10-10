# ADR-0001: Tab architecture — trip-expense agent over iMessage (Photon Spectrum · Gemini · Solana)

- **Status:** Accepted (HackNC 2026). Supersedes the earlier "Velo in the group chat" draft.
- **Date:** 2026-10-10
- **Tracks:** Best iMessage Agent with Photon · Solana · (Gemini as sponsor tech)

## Context

On group trips, one person ends up running a spreadsheet and chasing everyone for money. **Tab** is an AI agent with a real phone number. Friends text it receipts and expenses. Tab:
- works out who owes what,
- asks each person to approve their share,
- explains any number on request,
- reminds people who forget,
- settles up in USDC on Solana when someone texts PAY.

Constraints that shape the design:
- **3 people, about 36 hours.**
- **Photon Spectrum Pro uses a shared pool of numbers.** Each person may see Tab as a different number. The agent **cannot create or join group chats** and gets no group events; groups need a dedicated line, which is the Business plan.
- **People must be registered as project Users** (`POST https://spectrum.photon.codes/projects/{id}/users/`) before Tab can text them.
- **Photon has no OCR or AI.** It only carries messages and attachments.
- **Payments are Solana only.** Apple Pay and Stripe are out of scope.

## The user flow we're building

1. **Start a trip.** Amit texts Tab "new trip Asheville". Tab replies with an invite to paste into the friends' human group chat, which Tab is not in: "Join our Asheville tab 👉 <link>".
2. **Join.** Each friend taps the link, Tab texts them, they say their name, and they're in. Behind the scenes, each person gets a custodial Solana wallet with 500 test USDC. Nobody sees any crypto.
3. **Log an expense.** The payer texts a receipt photo and/or text. Examples:
   - "[photo] gas, everyone"
   - "dinner, me jake and sam, I didn't eat with Amit"
   - "pay me $30"
   - A receipt with no instructions makes Tab ask: **split evenly or by item?** "By item" lists the numbered items and asks "who had what?".
4. **Approve.** Everyone in the split gets their own text: "Amit logged Gas $80.00 (🧾 receipt). Your share: $20.00. Reply YES, DISPUTE + reason, or WHY." People outside the split aren't asked.
   - **Receipt-backed shares** auto-approve after a grace period (48h, or 5 min in demo mode).
   - **No-receipt shares never auto-approve.**
5. **Dispute.** "DISPUTE I don't remember any firewood" takes that share out of the balances and asks the payer for a receipt. When the payer sends a photo, the receipt is attached, everyone's share goes back to pending, and the disputers are asked first.
6. **WHY.** Tab gives a line-by-line breakdown: amount, payer, how it was split, receipt or no receipt with date, and your approval status.
7. **SETTLE.** Tab computes the fewest payments using approved shares only, then texts each debtor "You owe Amit $20.00 and Priya $32.00… Reply PAY", and each creditor what's coming.
8. **PAY.** Tab signs USDC transfers from the payer's Tab wallet and texts both sides "✅ Sent… · view on Solana".
9. **Reminders.** People get nudged about approvals still waiting on them, and about unpaid debts after a settle-up.

## Decisions

### D1. Messaging: 1:1 DMs over Spectrum Pro, behind a `Messenger` interface

- Tab only ever talks to people one-on-one, in `src/messaging/spectrum.ts`:
  - Inbound arrives through `app.messages` with `flattenGroups: true`.
  - The sender comes from `message.sender.id`, which is E.164.
  - Photos come from `content.type === "attachment"` and `content.read()`.
  - Text and a photo sent together arrive as two messages. They're **merged per sender within a 1.5s window**, so "[photo] gas, everyone" is handled as one message.
  - Proactive texts use `imessage(app).space.create(phone)`.
- **The invite is a web link** (`/j/:code`). A friend enters their number, the server registers them with Photon (Create User API), and Tab texts them first.
  - **Why not the `sms:` link?** On the shared pool there isn't one number to text, and the docs don't say what happens when an unregistered number texts a pool line.
  - If Photon gives us a dedicated line, set `BOT_PHONE` and the invite becomes `sms:+1…&body=JOIN CODE`. Texting "JOIN CODE" already works.
- **Local development** uses `SimMessenger`, a terminal simulator with many fake senders (`amit: …`, `jake: …`). Spectrum's own terminal provider can't fake multiple senders.
- **iMessage app extension** (the "Settle up" card in the app drawer): **deferred.** It's a separate Swift/Xcode project. Spectrum's `app(...)` cards are a possible shortcut later.

### D2. AI: Gemini reads and routes; TypeScript does the money

- **Receipts:** Gemini (vision, JSON schema) returns `{merchant, date, items[{name, qty, price_cents}], subtotal, tax, tip, total}` in integer cents. A consistency check (items ≈ subtotal, subtotal + tax + tip ≈ total) decides between "🧾 receipt matched" and plain "🧾 receipt".
- **Messages:** Gemini classifies intent (expense / why / balance / settle / pay / help) and extracts the amount, a description, and a **split spec**: `everyone | only [names] | except [names] | by_item | unspecified`, plus `includeSender`. It also parses item assignments like "1,3 Sam; 2 Jake; rest everyone".
- **Exact commands skip the LLM:** YES, DISPUTE, WHY, SETTLE, PAY, BALANCE, UNDO, LINK, HELP, JOIN, "new trip". They're fast, free and predictable.
- **Fallback:** `HeuristicAI` (keyword parsing) runs when there's no API key or Gemini errors, so the demo never hard-fails.
- **Rule: the LLM never does arithmetic.** All amounts are integer cents.
  - Even splits and item splits use largest-remainder rounding, so the parts always add up exactly to the total.
  - Tax and tip are split in proportion to each person's items.

### D3. Payments: custodial devnet wallets, test USDC

- Every member gets a `Keypair`. The secret is AES-256-GCM encrypted under `TAB_MASTER_KEY` and stored in SQLite.
- **Token:** our own 6-decimal SPL mint on devnet, shown to users as "USDC". The treasury is mint authority and gives each new wallet 500. The treasury also pays all transaction fees.
- **PAY:** `transferChecked` from the debtor's associated token account to the creditor's (creating it idempotently if needed), signed by the debtor plus the treasury. Each transfer is recorded with its signature and linked on Explorer.
- **`SOLANA_MODE=mock`** fakes the chain so development and tests need no network. `npm run solana:setup` creates the treasury and mint for devnet.
- **Risk, stated openly:** custody is acceptable for a devnet demo only. The production path is MPC/embedded wallets (Privy, Crossmint or Turnkey) and real USDC.

### D4. Ledger: approvals gate the balances

- **Tables:** `users`, `trips(code, settle_requested_at)`, `members`, `expenses(has_receipt, receipt_json, receipt_at)`, `shares(cents, status pending|approved|disputed, dispute_reason, notified_at, reminded_at)`, `transfers`, `payment_nudges`, and `pending`. `pending` holds one open question per user: awaiting_name / reason / amount / split_mode / items / receipt.
- **Balances count approved shares only.** The payer's own share is approved automatically. Net = Σ(others' approved shares on what I paid) − Σ(my approved shares on what others paid) + sent − received.
- **Settle:** a greedy minimum-payments algorithm, so n people need at most n−1 payments.
- **YES and DISPUTE** act on the user's oldest pending share. DISPUTE falls back to their most recently approved share, so people can push back after an auto-approve.

### D5. Background job

`runJobs()` runs on an interval and does three things:
1. Auto-approves receipt-backed shares past the grace period.
2. Sends grouped approval reminders ("Reminder: 1 expense needs your OK: Dinner $32.00 (Priya)").
3. Sends payment reminders after a settle-up.

`DEMO_MODE=1` shrinks the timers to minutes.

### D6. Web: invite page + read-only trip page

There's no group chat, so `/t/:code` is the shared view: balances, the settle-up plan, payments with Explorer links, and every expense with each person's approval status. `/j/:code` is the invite landing page. Both are served by Hono in the same process.

## Architecture

```
friend's iPhone ⇄ 1:1 iMessage ⇄ Photon Spectrum (shared pool) ⇄ SpectrumMessenger ─┐
                                                       (dev: SimMessenger, terminal) │
browser ──► /j/:code (register with Photon, Tab texts first) ──────────────────────┤
browser ──► /t/:code (read-only trip page)                                          ▼
                                                                     Tab (src/agent/bot.ts)
                                       ┌──────────────────────┬──────────┴─────────┬──────────────────┐
                                  AI (Gemini | Heuristic)   Ledger (SQLite)    Chain (Devnet | Mock)   runJobs()
                                  receipts, intents,        split.ts, settle.ts  wallets, USDC transfers  auto-approve,
                                  item assignment                                                          reminders
```

### Repo layout (as built)
```
src/index.ts                 wiring: config → store, AI, chain, messenger, bot, web, job interval
src/config.ts                env config (MESSENGER, SOLANA_MODE, DEMO_MODE, timers)
src/agent/bot.ts             Tab: every flow above (commands, conversations, approvals, settle, pay, jobs)
src/agent/format.ts          money/name/date formatting
src/ai/{types,gemini,heuristic}.ts
src/ledger/db.ts             SQLite schema + Store queries
src/ledger/split.ts          allocate, splitEven, splitItems, receipt checks
src/ledger/settle.ts         netBalances, minTransfers, tripLedger, breakdownFor
src/messaging/{types,spectrum,sim,photon-users}.ts
src/solana/chain.ts          Chain interface, key encryption, MockChain
src/solana/devnet.ts         DevnetChain (spl-token)
src/web/server.ts            /j/:code, /t/:code
scripts/solana-setup.ts      treasury + test USDC mint + master key
scripts/register-users.ts    register demo phones with Photon
scripts/receipt-eval.ts      run Gemini over sample receipts
test/ledger.test.ts          money math + parsing
test/story.test.ts           the full Asheville story, end to end
```

## Team split

| Person | Owns next |
|---|---|
| **A: Messaging** | Spectrum on real phones: merge window, registration, delivery errors, ngrok `PUBLIC_URL`; dedicated-line `sms:` invite if granted |
| **B: AI** | Gemini prompts on real receipts (`scripts/receipt-eval.ts`), tricky split phrasing, model choice |
| **C: Money + web** | `solana:setup` on devnet, PAY on real devnet, trip page polish for the projector |

## Consequences

**Positive**
- Works on the plan we have (Spectrum Pro).
- Approvals and disputes make the numbers trustworthy, and receipts are what earn auto-approval.
- Everything except receipt reading and free-text understanding is deterministic and tested.

**Negative / risks**
- **No shared view inside iMessage.** The trip page covers this. A dedicated line or the iMessage extension would remove it.
- **Shared pool:** Tab may look like a different number to each person.
- **Custodial keys:** devnet only, and disclosed as such.
- **OCR mistakes:** caught by the consistency check, disputes, and UNDO.

## Open questions
- Will Photon grant a dedicated line at the event? If so: `sms:` invites, and optionally group-chat mode.
- What happens when an unregistered number texts a shared-pool line? Test it at the event.
- Which Gemini model is current at the event? It's set with `GEMINI_MODEL`.
