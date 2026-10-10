# Tab 💸

**The friend on your trip who handles the money, over iMessage.**

Tab is an AI agent with a real phone number. Friends on a trip text it receipts and expenses. Tab splits them, asks each person to OK their share, explains any number on request, nudges people who forget, and settles up in USDC on **Solana** when someone texts PAY. There's no app to install, no spreadsheet, and no crypto in sight.

Built at HackNC 2026 for the **Best iMessage Agent with Photon** and **Solana** tracks.

## How it feels

```
Amit:  new trip Asheville
Tab:   Asheville Trip created! Paste this in your group chat:
       "Join our Asheville tab 👉 https://…/j/ASHE42"

Amit:  [receipt photo] gas, everyone
Tab:   Logged to Asheville Trip: Gas $80.00 · split 4 ways ($20 each) · 🧾 receipt matched.
       I've asked Jake, Priya, and Sam to OK their shares.

Jake:  why do I owe so much
Tab:   You owe $59.50 total:
       • $20.00 to Amit: Gas ($80 ÷ 4), receipt Oct 11, you approved
       • $32.00 to Priya: Dinner ($96 ÷ 3), receipt Oct 11, you approved
       • $7.50 to Sam: Firewood ($30 ÷ 4), receipt added Oct 12, still waiting on your OK

Jake:  PAY
Tab:   ✅ Sent $52.00 USDC: Priya $32, Amit $20 · view on Solana
```

**Features**
- **Receipts:** split evenly, by who was there ("me, Jake and Sam"), or by item ("1,3 Sam; 2 Jake; rest everyone").
- **Approvals:** YES, DISPUTE + reason, or WHY. Receipt-backed shares auto-approve after a grace period; no-receipt shares never do.
- **Settling:** SETTLE finds the fewest payments, and PAY sends USDC from your Tab wallet.
- **Reminders:** Tab nudges people about approvals waiting on them and about unpaid debts.
- **Trip page:** a read-only page with balances, every expense, and on-chain payment links.

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

**Real iMessage (demo with fixed people).**
1. Put `.env` in this folder (next to `package.json`), with `MESSENGER=spectrum` and `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` from the Photon dashboard.
2. In the Photon dashboard, **Spectrum → Users → Add user**, add each demo person's phone. On the Pro plan every person gets their own **"Texts on"** number: that is the number *they* text Tab at (it can differ per person). Have each person save it as a contact called "Tab".
3. Organizer texts `new trip Asheville`. Friends text `JOIN <code>` to their Tab number. Done; no web link needed.
4. Optional: expose the server (`ngrok http 3000`) and set `PUBLIC_URL` so the trip page link works on phones. Then the `/j/<code>` invite link also works for people who aren't pre-registered (it registers them via the Photon API).

**Real Solana (devnet).** Run `npm run solana:setup`, paste the printed values into `.env`, and set `SOLANA_MODE=devnet`.

**Receipts.** Set `GEMINI_API_KEY`, then check accuracy on real photos with `npm run receipt:eval -- samples/*.jpg`.

## Commands Tab understands

`new trip <name>` · `JOIN <code>` · receipt photos · "paid $X for Y" · `YES` · `DISPUTE <reason>` · `WHY` · `BALANCE` · `SETTLE` · `PAY` · `UNDO` · `LINK` · `HELP`
