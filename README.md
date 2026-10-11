# Tab 💸

**The friend on your trip who handles the money, over iMessage.**

Tab is an AI agent with a real phone number. Friends on a trip text it receipts and expenses in plain English. Tab splits them, keeps everyone's running total, explains any number on request, and settles up in USDC on **Solana** when someone says "pay". There is no app to install, no account to make, no spreadsheet, and no crypto in sight.

**HackNC 2026** · Team: Prasun Sapkota, Amit Khanal, Ayug (add surnames) · [Devpost](https://hacknc-2026.devpost.com/) · 🎥 **Demo video: ADD LINK** · Live: https://tab-production-2bdf.up.railway.app

Submitted to: **General track** · **Best iMessage Agent with Photon** · **MLH Best Use of Gemini API** · **MLH Best Use of Solana**

## How it feels

```
Prasun: i am going on a new trip to florida
Tab:    Florida Trip created! Friends can text Tab "JOIN FLOR76", or forward them this link:
        https://tab-production-2bdf.up.railway.app/j/FLOR76        ← rich card in iMessage

Prasun: [receipt photo] gas, everyone
Tab:    Logged to Florida Trip: Gas $80.00 · split 3 ways (~$26.67 each). I've told Ayug and Amit.
(Ayug)  Prasun logged Gas $80.00 · your share $26.67.

Ayug:   that gas charge is wrong, I took the train
Tab:    Got it. I've taken Gas ($26.67) off your total until Prasun adds a receipt or agrees.
(Prasun) Ayug disputed Gas ($26.67): "I took the train". Should I take Ayug off it, or do you have a receipt?
Prasun: ya fair, take him off
(Ayug)  Prasun agreed: you're off Gas.

Amit:   what's my total
Tab:    Florida Trip running total: you owe Prasun $40.00.
        Overall you owe $40.00. Say pay whenever you're ready, or ask me why.
        Everything, line by line: https://…/t/FLOR76       ← opens already on Amit

Amit:   pay prasun
Tab:    ✅ Sent $40.00 USDC: Prasun $40 · view on Solana: https://explorer.solana.com/tx/…
(Prasun) 💸 Amit paid you $40.00 USDC for Florida Trip. https://explorer.solana.com/tx/…
```

## What it does

- **Logs expenses from a text or a photo.** Gemini reads the receipt; you can split evenly, by who was there ("me, Jake and Sam"), or by item ("1,3 Sam; 2 Jake; rest everyone").
- **Keeps a running tab per person, netted.** Every share counts the moment it's logged. If you paid for lunch and they paid for drinks, you only ever see the difference. TOTAL shows it; WHY lists every line behind it.
- **Disputes, not approvals.** Nobody is asked to approve anything. If a charge is wrong you say so, in any words; your share comes off until the payer sends a receipt or agrees, and the rest is re-split.
- **Pays on Solana.** "pay" sends USDC from a wallet Tab holds for you to exactly the people you owe, with the explorer link as proof. "pay amit" pays just Amit. The treasury covers fees, so friends never see gas or keys.
- **Several trips at once.** Name the trip inline ("$80 gas, florida"). If an expense doesn't say, Tab asks one question. Disputes, agreeing, and undo follow the expense, so they never ask.
- **Closes trips cleanly.** "we're done with cali, everyone venmo'd me" closes the trip and books the leftovers as settled outside Tab. If money is still owed Tab asks what you want to do instead of refusing.
- **One reminder a day,** only to people who owe, never on top of a total they already got. "remind Jake" nudges one person on your behalf.
- **Trip page.** An installable mobile page per trip: your running total with every expense behind each number, everyone's balances, and on-chain payment links. Links Tab texts you open already on you.

## How it talks (the part we're proudest of)

There are no magic words. Every message goes to Gemini with the context (who you are, your open trips, who owes what, any open dispute) and the model picks **one action from a fixed list** and its details: log an expense, dispute, pay these people, close this trip, and so on. The code then performs that action deterministically. When Tab needs a decision it asks a plain question ("Did you all settle that outside Tab, or should I keep it open until it's paid?") and the answer is read the same way, so "ya they both zelled me" and "eh just close it" both work.

Why bounded actions instead of letting the model run free: Tab moves money. The model does all the understanding, where it is strong; the ledger math, the payments, and every message to your friends are deterministic and unit-tested. The model never writes free text to anyone and never computes a balance. If Gemini is unreachable, a keyword fallback keeps the exact commands working.

## Stack

| Layer | Tech |
|---|---|
| Messaging | **Photon Spectrum** (`spectrum-ts`): inbound iMessages over Photon's gRPC stream, replies via the SDK, one "Texts on" line per person from the Pro shared pool, people registered through the Users API so nobody needs a Photon account |
| AI | **Google Gemini** (`@google/genai`, gemini-2.5-flash with model fallback): receipt vision, intent classification, and answer interpretation, all with strict JSON schemas |
| Payments | **Solana devnet**: `@solana/web3.js` + `@solana/spl-token`, custodial encrypted wallet per member, treasury-paid fees, 6-decimal test USDC, explorer links on every payment |
| Backend | TypeScript on Node 20, Hono, SQLite (`better-sqlite3`), sharp for the generated link-preview cards |
| Hosting | Railway (Docker, persistent volume for SQLite) |

Design notes and trade-offs: [`docs/adr/0001-velo-architecture.md`](docs/adr/0001-velo-architecture.md).

> ⚠️ **Demo money.** Tab holds an encrypted devnet wallet for each person so paying is one text. A production version would use embedded or MPC wallets and real USDC with an on-ramp.

## How we used AI to build it

Gemini is what runs inside Tab. Building Tab was a separate job, and for that we used **Claude Code** as a pair programmer for most of the hackathon:

- **Main agent:** Claude Code worked in the repo with us. It wrote and refactored the TypeScript, ran `npm test` after changes, and fixed whatever broke. Most of the commit history came out of those sessions.
- **Subagents in parallel:** for bigger pieces we had Claude Code start several subagents at once. Some searched the codebase, some planned a feature (multi-trip routing, disputes, settling), and some reviewed a diff for bugs while the main session kept going. That way the main session didn't get filled up with search results.
- **Reviews and docs:** we ran code-review passes before merging the money logic, and Claude helped draft the ADR and this README.

We made the product decisions and checked the money math ourselves. The end-to-end Asheville test is how we confirmed that changes Claude made didn't break splits or settlements.

## Run it

```bash
npm install
cp .env.example .env
npm test          # 44 tests: ledger math, the full trip story, multi-trip, disputes, personal links
npm run dev       # local simulator + web server on :3000
```

**Simulator.** With `MESSENGER=sim` you play every person from one terminal:

```
> amit: new trip Asheville
> amit: Amit
> jake: JOIN ASHE42                 (the code Tab printed)
> jake: Jake
> amit: paid $80 for gas, everyone
> jake: that's wrong, I wasn't in the car
> amit: fine take him off
> jake: what do I owe
> jake: pay
```

The trip page is at `http://localhost:3000/t/<CODE>`.

**Real iMessage (Photon).**
1. Set `MESSENGER=spectrum` and `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` from the Photon dashboard.
2. Nobody else needs a Photon account. The start page (`/`) registers an organizer's number through Photon's Users API and shows the number to text; the invite page (`/j/<code>`) does the same for friends. On the Pro shared pool each person gets their own "Texts on" number, so have them save it as a contact called Tab.
3. Photon's gateway takes a minute or two to accept a freshly registered number. Tab retries the first text for that long and the pages say so.

**Solana (devnet).** `npm run solana:setup` creates the treasury and test USDC mint; paste the printed values into `.env` and set `SOLANA_MODE=devnet`.

**Gemini.** Set `GEMINI_API_KEY` (a billing-enabled key; the free tier is 20 requests a day). `npm run receipt:eval -- samples/*.jpg` checks receipt accuracy on real photos.

**Deploy (Railway).** Tab is one long-lived process (Photon stream, a timer, a SQLite file), so it wants a container with a disk. The repo has a `Dockerfile`; attach a volume at `/app/data`, set the `.env` values plus `DB_PATH=/app/data/tab.db` and `PUBLIC_URL`, and `railway up`.

## Short forms Tab also understands

`new trip <name>` · `JOIN <code>` · `TOTAL` · `WHY` · `DISPUTE <reason>` · `remind <name|everyone>` · `SETTLE` · `PAY` / `pay <name>` · `UNDO` · `LINK` · `TRIPS` · `close <trip>` · `call me <name>` · `HELP`

## Safety and fallbacks

- The model can only choose from a fixed action list; it cannot invent an expense from small talk, send a message, or move money on its own.
- Every money change is deterministic, idempotent where it matters (double-PAY guard, partial-failure handling), and covered by tests.
- Disputes pull a share out immediately; nothing counts against you while it's contested.
- Closing a trip with balances open requires an explicit choice, and off-platform settlements are recorded, not silently dropped.
- If Gemini is down or out of quota, exact commands and common phrasings still work through a keyword fallback, and a receipt that can't be read turns into "What was the total?" instead of a guess.

## What's next

Mainnet USDC with a real on-ramp and embedded wallets, Postgres for scale, smarter receipt item matching, and group-chat participation once Photon supports it.
