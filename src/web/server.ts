import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { Tab } from "../agent/bot.js";
import { fmt, shortDate } from "../agent/format.js";
import type { Store } from "../ledger/db.js";
import { tripLedger } from "../ledger/settle.js";
import { toE164 } from "../messaging/types.js";
import type { Chain } from "../solana/chain.js";

const STYLE = `
:root{--bg:#fafaf7;--fg:#1d1d1f;--muted:#6e6e73;--card:#fff;--line:#e5e5ea;--accent:#0a7cff;--ok:#1f9d55;--warn:#c27c0e;--bad:#d1342f}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#f2f2f2;--muted:#9a9aa0;--card:#1c1c1e;--line:#2c2c2e;--accent:#4aa3ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:640px;margin:0 auto;padding:24px 16px 48px}h1{font-size:28px;margin:8px 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:28px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:8px 0}
.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}.muted{color:var(--muted);font-size:14px}
.pill{font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid var(--line);white-space:nowrap}
.approved{color:var(--ok)}.pending{color:var(--warn)}.disputed{color:var(--bad)}.pos{color:var(--ok)}.neg{color:var(--bad)}
a{color:var(--accent)}input,button{font:inherit;padding:12px 14px;border-radius:12px;border:1px solid var(--line);width:100%;margin-top:8px;background:var(--card);color:var(--fg)}
button{background:var(--accent);color:#fff;border:0;font-weight:600}
`;

function page(title: string, body: ReturnType<typeof html>) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${raw(STYLE)}</style></head><body><main>${body}</main></body></html>`;
}

export function startWeb(opts: { store: Store; bot: Tab; chain: Chain; port: number; botName: string }) {
  const { store, bot, chain, botName } = opts;
  const app = new Hono();

  app.get("/", (c) => c.html(page(botName, html`<h1>${botName} 💸</h1><p>Split trip expenses over iMessage. Settle up on Solana.</p>`)));

  // Invite landing page. On Spectrum Pro (shared pool) we register the number, then Tab texts first.
  app.get("/j/:code", (c) => {
    const trip = store.tripByCode(c.req.param("code"));
    if (!trip) return c.html(page("Not found", html`<h1>Hmm 🤔</h1><p>That invite link doesn't exist.</p>`), 404);
    const organizer = store.user(trip.organizer_id);
    return c.html(
      page(
        `Join ${trip.name}`,
        html`<h1>Join ${trip.name}</h1>
          <p class="muted">${organizer.name ?? "A friend"} is using ${botName} to split costs. Enter your number and ${botName} will text you.</p>
          <form method="post"><input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(919) 555-0123" required>
          <button>Text me</button></form>`,
      ),
    );
  });

  app.post("/j/:code", async (c) => {
    const code = c.req.param("code");
    const trip = store.tripByCode(code);
    if (!trip) return c.html(page("Not found", html`<h1>Hmm 🤔</h1><p>That invite link doesn't exist.</p>`), 404);
    const form = await c.req.parseBody();
    const phone = toE164(String(form.phone ?? ""));
    if (!phone) return c.html(page("Try again", html`<h1>That number doesn't look right</h1><p><a href="/j/${code}">Try again</a></p>`), 400);
    try {
      await bot.joinByPhone(phone, code);
    } catch (err) {
      console.error("[web] join failed", err);
      return c.html(page("Something broke", html`<h1>Something went wrong 😬</h1><p>Try again in a minute.</p>`), 500);
    }
    return c.html(page("Check your texts", html`<h1>Check your texts 📱</h1><p>${botName} just messaged you about ${trip.name}.</p>`));
  });

  // Read-only trip page: the shared view of everything (there's no group chat on Spectrum Pro).
  app.get("/t/:code", (c) => {
    const trip = store.tripByCode(c.req.param("code"));
    if (!trip) return c.html(page("Not found", html`<h1>Trip not found</h1>`), 404);
    const { members, expenses, transfers, net, plan } = tripLedger(store, trip.id);
    const name = (id: number) => store.user(id).name ?? "Someone";

    const balances = members.map((m) => {
      const v = net.get(m.id) ?? 0;
      return html`<div class="card row"><span>${name(m.id)}</span><b class="${v > 0 ? "pos" : v < 0 ? "neg" : ""}">${
        v > 0 ? `is owed ${fmt(v)}` : v < 0 ? `owes ${fmt(-v)}` : "square"
      }</b></div>`;
    });
    const planHtml = plan.length
      ? plan.map((d) => html`<div class="card row"><span>${name(d.from)} → ${name(d.to)}</span><b>${fmt(d.cents)}</b></div>`)
      : html`<p class="muted">Nothing to settle 🎉</p>`;
    const expenseHtml = [...expenses].reverse().map(
      ({ expense: e, shares }) => html`<div class="card">
        <div class="row"><b>${e.description}</b><b>${fmt(e.total_cents)}</b></div>
        <div class="muted">${name(e.payer_id)} paid · ${shortDate(e.created_at)} · ${e.has_receipt ? "🧾 receipt" : "⚠️ no receipt"}</div>
        ${shares
          .filter((s) => s.user_id !== e.payer_id)
          .map(
            (s) => html`<div class="row muted"><span>${name(s.user_id)} ${fmt(s.cents)}</span><span class="pill ${s.status}">${s.status}${
              s.dispute_reason ? `: ${s.dispute_reason}` : ""
            }</span></div>`,
          )}
      </div>`,
    );
    const transferHtml = transfers.length
      ? [...transfers].reverse().map(
          (t) => html`<div class="card row"><span>${name(t.from_id)} paid ${name(t.to_id)} <b>${fmt(t.cents)}</b></span>${
            t.tx_sig ? html`<a href="${chain.explorerUrl(t.tx_sig)}" target="_blank" rel="noopener">view on Solana ↗</a>` : ""
          }</div>`,
        )
      : html`<p class="muted">No payments yet.</p>`;

    return c.html(
      page(
        trip.name,
        html`<h1>${trip.name}</h1><p class="muted">${members.map((m) => name(m.id)).join(" · ")}</p>
        <h2>Balances</h2>${balances}<h2>Settle up</h2>${planHtml}
        <h2>Payments (Solana devnet)</h2>${transferHtml}<h2>Expenses</h2>${expenseHtml}
        <p class="muted">Only approved shares count toward balances.</p>`,
      ),
    );
  });

  const server = serve({ fetch: app.fetch, port: opts.port });
  console.log(`[web] listening on http://localhost:${opts.port}`);
  return { app, server };
}
