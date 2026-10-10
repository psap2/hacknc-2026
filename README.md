# Tab 💸

**The friend on your trip who handles the money, over iMessage.**

Tab is an AI agent with a real phone number. Friends on a trip text it receipts and expenses. Tab splits them, keeps everyone's running total, explains any number on request, and settles up in USDC on **Solana** when someone texts PAY. Shares count the moment they're logged; you only speak up to **dispute** one. There's no app to install, no spreadsheet, and no crypto in sight.

Built at HackNC 2026 for the **Best iMessage Agent with Photon** and **Solana** tracks.

## How it feels

```
Amit:  new trip Asheville
Tab:   Asheville Trip created! Paste this in your group chat:
       "Join our Asheville tab 👉 https://…/j/ASHE42"

Amit:  [receipt photo] gas, everyone
Tab:   Logged to Asheville Trip: Gas $80.00 · split 4 ways ($20 each).
       I've told Jake, Priya, and Sam.
(Jake) Amit logged Gas $80.00 (🧾 receipt) · your share $20.00. Running total: you owe Amit $20.00.
       Reply DISPUTE + reason if that's wrong, or TOTAL to see where you stand.

Jake:  what's my total
Tab:   Asheville Trip running total: you owe Amit $20.00, Priya $32.00, and Sam $7.50.
       Net: you owe $59.50. Reply PAY to settle up or WHY for every line.
       Everything, line by line: https://…/t/ASHE42

Jake:  PAY
Tab:   ✅ Sent $59.50 USDC: Amit $52.50, Priya $7 · view on Solana
```

**Features**
- **Receipts:** split evenly, by who was there ("me, Jake and Sam"), or by item ("1,3 Sam; 2 Jake; rest everyone").
- **Running totals:** every share counts as soon as it's logged. Each person gets one text with their share and their running total per person, netted (if you paid for lunch and they paid for drinks, you only see the difference).
- **Disputes:** DISPUTE + reason pulls your share out until the payer adds a receipt or removes the expense. YES takes a dispute back. Nobody is ever asked to approve anything.
- **Settling:** SETTLE finds the fewest payments, and PAY sends USDC from your Tab wallet.
- **Reminders:** one running-total text a day to anyone who owes, and never on top of a total they already got that day. "remind Jake" (or "remind everyone") texts them what they owe you right now.
- **Trip page:** an installable mobile page. Tap your name to see your running total with every expense behind each number, plus everyone's balances, the settle plan, and on-chain payment links.

## Stack

| Layer | Tech |
|---|---|
| Messaging | Photon Spectrum (`spectrum-ts`, cloud iMessage, Pro shared pool) |
| AI | Google Gemini (receipt vision + message understanding), with keyword fallback |
| Payments | Solana devnet, `@solana/web3.js` + `@solana/spl-token`, 6-decimal test USDC |
| Backend | TypeScript on Node 20, SQLite (`better-sqlite3`), Hono |

Design and trade-offs: [`docs/adr/0001-velo-architecture.md`](docs/adr/0001-velo-architecture.md).

> ⚠️ **Demo only.** Tab holds an encrypted devnet wallet for each person so paying takes one tap. A production version would use embedded/MPC wallets and real USDC.

## Run it

```bash
npm install
cp .env.example .env
npm test          # money math + the full Asheville story end to end
npm run dev       # starts the local simulator + web server on :3000
```

**Simulator.** With `MESSENGER=sim` you play every person from one terminal:

```
> amit: new trip Asheville
> amit: Amit
> jake: JOIN ASHE42          (use the code Tab printed)
> jake: Jake
> amit: paid $80 for gas, everyone
> jake: YES
> amit: [img samples/receipt.jpg] dinner, by item
> jake: SETTLE
> jake: PAY
```

The trip page is at `http://localhost:3000/t/<CODE>`.

**Real iMessage.**
1. Put `.env` in this folder (next to `package.json`), with `MESSENGER=spectrum` and `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` from the Photon dashboard.
2. Nobody needs a Photon account. The start page (`/`) registers an organizer's number through Photon's API and shows them the number to text; the invite page (`/j/<code>`) does the same for friends. On the Pro shared pool every person gets their own **"Texts on"** number, so have people save theirs as a contact called "Tab".
3. Photon's gateway takes a minute or two to accept a freshly registered number. Tab retries the first text for that long and the pages say so.

**Deploy (Railway).** Tab is one long-lived Node process (it holds a stream to Photon, runs a timer, and keeps a SQLite file), so it wants a container host with a disk, not serverless. The repo has a `Dockerfile`; on Railway attach a volume at `/app/data`, set the `.env` values as service variables plus `DB_PATH=/app/data/tab.db` and `PUBLIC_URL=https://<your-domain>`, and `railway up`. Railway rejects a `VOLUME` line in the Dockerfile and better-sqlite3 compiles from source there, which the Dockerfile already accounts for.

**Real Solana (devnet).** Run `npm run solana:setup`, paste the printed values into `.env`, and set `SOLANA_MODE=devnet`.

**Receipts.** Set `GEMINI_API_KEY`, then check accuracy on real photos with `npm run receipt:eval -- samples/*.jpg`.

## Commands Tab understands

`new trip <name>` · `JOIN <code>` · receipt photos · "paid $X for Y" · `TOTAL` (or "what's my total") · `WHY` · `DISPUTE <reason>` · `YES` (takes a dispute back) · `remind <name|everyone>` · `SETTLE` · `PAY` · `UNDO` · `LINK` · `call me <name>` · `HELP`
