import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { html, raw } from "hono/html";
import sharp from "sharp";
import type { Tab } from "../agent/bot.js";
import { fmt, shortDate } from "../agent/format.js";
import type { Store } from "../ledger/db.js";
import { tripLedger } from "../ledger/settle.js";
import { toE164 } from "../messaging/types.js";
import type { Chain } from "../solana/chain.js";

// ---------------------------------------------------------------- look & feel

const STYLE = `
:root{--bg:#f6f3ee;--fg:#17151a;--muted:#6f6a75;--card:#ffffff;--line:#e8e2da;--accent:#6b3df5;--accent-2:#ff6a3d;--ok:#1b8a4c;--warn:#b7791f;--bad:#d7263d;--chip:#f0ebff;--shadow:0 10px 30px rgba(40,20,80,.08)}
:root:not([data-theme="light"]){color-scheme:light dark}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0f0d13;--fg:#f4f1f8;--muted:#9d97a8;--card:#1a1720;--line:#2a2633;--accent:#a98bff;--accent-2:#ff8b63;--ok:#4cc38a;--warn:#e2b25a;--bad:#ff6b7a;--chip:#2a2340;--shadow:0 10px 30px rgba(0,0,0,.35)}}
:root[data-theme="dark"]{--bg:#0f0d13;--fg:#f4f1f8;--muted:#9d97a8;--card:#1a1720;--line:#2a2633;--accent:#a98bff;--accent-2:#ff8b63;--ok:#4cc38a;--warn:#e2b25a;--bad:#ff6b7a;--chip:#2a2340;--shadow:0 10px 30px rgba(0,0,0,.35)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Inter,sans-serif;overflow-x:hidden}
main{max-width:560px;margin:0 auto;padding:16px 16px 56px}
.hero{position:relative;overflow:hidden;border-radius:28px;padding:28px 22px 24px;color:#fff;background:linear-gradient(135deg,#6b3df5 0%,#b23df5 45%,#ff6a3d 100%);box-shadow:var(--shadow)}
.hero::after{content:"";position:absolute;inset:auto -40px -60px auto;width:220px;height:220px;border-radius:50%;background:rgba(255,255,255,.14)}
.hero .kicker{font-size:13px;letter-spacing:.12em;text-transform:uppercase;opacity:.85;margin:0 0 6px}
.hero h1{font-size:clamp(32px,9vw,42px);line-height:1.02;letter-spacing:-.02em;margin:0 0 10px;font-weight:800}
.hero p{margin:0;opacity:.92;font-size:16px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:28px 4px 10px;font-weight:700}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:16px;margin:10px 0;box-shadow:var(--shadow)}
.row{display:flex;justify-content:space-between;gap:12px;align-items:center}
.muted{color:var(--muted);font-size:14px}.small{font-size:13px}
.big{font-size:34px;font-weight:800;letter-spacing:-.02em;line-height:1.1}
.pos{color:var(--ok)}.neg{color:var(--bad)}.warn{color:var(--warn)}
.pill{font-size:12px;padding:3px 9px;border-radius:99px;background:var(--chip);color:var(--accent);white-space:nowrap;font-weight:600}
.pill.disputed{background:color-mix(in srgb,var(--bad) 14%,transparent);color:var(--bad)}
.pill.ok{background:color-mix(in srgb,var(--ok) 14%,transparent);color:var(--ok)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 2px}
.chip{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:99px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer}
.chip[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:#fff}
.avatar{width:36px;height:36px;border-radius:50%;display:inline-grid;place-items:center;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent-2));flex:none}
.who{display:flex;align-items:center;gap:12px}
details{border-top:1px solid var(--line);margin-top:10px;padding-top:10px}
details summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:12px}
details summary::-webkit-details-marker{display:none}
details summary::after{content:"›";color:var(--muted);font-size:22px;transition:transform .15s}
details[open] summary::after{transform:rotate(90deg)}
.line{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:14px}
.line + .line{border-top:1px dashed var(--line)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
input,button{font:inherit;width:100%;margin-top:10px}
input{padding:14px 16px;border-radius:14px;border:1px solid var(--line);background:var(--card);color:var(--fg);font-size:18px}
button.primary,a.primary{display:block;text-align:center;padding:15px 18px;border-radius:14px;border:0;background:var(--accent);color:#fff;font-weight:700;font-size:17px;cursor:pointer}
.empty{color:var(--muted);text-align:center;padding:18px 8px}
footer{margin-top:40px;text-align:center}
@media (max-width:360px){.big{font-size:28px}}
`;

const ICON_SVG = (size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b3df5"/><stop offset=".5" stop-color="#b23df5"/><stop offset="1" stop-color="#ff6a3d"/></linearGradient></defs>
  <rect width="100" height="100" rx="24" fill="url(#g)"/>
  <text x="50" y="66" text-anchor="middle" font-family="-apple-system,Helvetica,Arial,sans-serif" font-weight="800" font-size="52" fill="#fff">T</text>
</svg>`;

function shell(title: string, body: ReturnType<typeof html>, opts: { botName: string; description?: string }) {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title><meta name="description" content="${opts.description ?? `${opts.botName}: split trip costs over iMessage, settle on Solana.`}">
<meta name="theme-color" content="#6b3df5"><link rel="manifest" href="/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="${opts.botName}"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="apple-touch-icon" href="/icon-180.png"><link rel="icon" href="/icon-180.png">
<style>${raw(STYLE)}</style></head><body><main>${body}</main></body></html>`;
}

const smsLink = (line: string, body: string) => `sms:${line}?&body=${encodeURIComponent(body)}`;

// ---------------------------------------------------------------- server

export function startWeb(opts: { store: Store; bot: Tab; chain: Chain; port: number; botName: string }) {
  const { store, bot, chain, botName } = opts;
  const app = new Hono();
  const page = (title: string, body: ReturnType<typeof html>, description?: string) => shell(title, body, { botName, description });

  // --- PWA bits: manifest + icons rendered from the SVG once.
  const icons = new Map<number, Promise<Buffer>>();
  const icon = (size: number) => {
    let p = icons.get(size);
    if (!p) {
      p = sharp(Buffer.from(ICON_SVG(size))).png().toBuffer();
      icons.set(size, p);
    }
    return p;
  };
  app.get("/manifest.webmanifest", (c) =>
    c.json(
      {
        name: botName,
        short_name: botName,
        description: "Split trip costs over iMessage. Settle on Solana.",
        start_url: "/",
        display: "standalone",
        background_color: "#f6f3ee",
        theme_color: "#6b3df5",
        icons: [
          { src: "/icon-180.png", sizes: "180x180", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      200,
      { "Content-Type": "application/manifest+json" },
    ),
  );
  for (const size of [180, 512]) {
    app.get(`/icon-${size}.png`, async (c) => c.body(new Uint8Array(await icon(size)), 200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" }));
  }

  // --- Start page: the front door for an organizer. We register their number with Photon
  // (so their first text reaches us) and hand them the number to text.
  const startForm = (error?: string) => html`
    <div class="hero"><p class="kicker">Trip money, handled</p><h1>${botName} is the friend who keeps the tab.</h1>
      <p>Text receipts. Everyone's share is tracked. Settle up in one tap.</p></div>
    <div class="card"><b>Start a trip</b>
      <p class="muted" style="margin:4px 0 0">Enter your number and ${botName} gives you a number to text. No app, no account.</p>
      <form method="post" action="/start">
        <input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(919) 555-0123" required>
        ${error ? html`<p class="neg small" style="margin:8px 0 0">${error}</p>` : ""}
        <button class="primary">Get my ${botName} number</button>
      </form></div>
    <p class="muted small" style="text-align:center">Got an invite code? Enter your number above, then text <b>JOIN &lt;code&gt;</b>.</p>`;

  app.get("/", (c) => c.html(page(botName, startForm())));

  app.post("/start", async (c) => {
    const form = await c.req.parseBody();
    const phone = toE164(String(form.phone ?? ""));
    if (!phone) return c.html(page(botName, startForm("That number doesn't look right. Try 10 digits.")), 400);
    let line: string | undefined;
    try {
      ({ line } = await bot.startByPhone(phone));
    } catch (err) {
      console.error("[web] start failed", err);
      return c.html(page(botName, startForm("Couldn't set you up just now. Try again in a minute.")), 500);
    }
    const body = "new trip ";
    return c.html(
      page(
        `Your ${botName} number`,
        html`<div class="hero"><p class="kicker">You're set</p><h1>Text ${botName} to start.</h1>
            <p>Say <b>new trip Asheville</b> (or wherever you're going).</p></div>
          <div class="card" style="text-align:center">
            <div class="muted small">Your ${botName} number</div>
            <div class="big" style="margin:6px 0 10px">${line ?? "…"}</div>
            ${line ? html`<a class="primary" href="${smsLink(line, body)}">Open Messages</a>` : ""}
            <p class="muted small" style="margin:12px 0 0">Save it as “${botName}”. It can take a minute or two before the first reply arrives.</p>
          </div>`,
      ),
    );
  });

  // --- Invite landing: a friend types their number, we register it and text them.
  app.get("/j/:code", (c) => {
    const trip = store.tripByCode(c.req.param("code"));
    if (!trip) return c.html(page("Not found", html`<div class="card empty">That invite link doesn't exist.</div>`), 404);
    const organizer = store.user(trip.organizer_id);
    return c.html(
      page(
        `Join ${trip.name}`,
        html`<div class="hero"><p class="kicker">You're invited</p><h1>${trip.name}</h1>
            <p>${organizer.name ?? "A friend"} is using ${botName} to split costs. Enter your number and ${botName} will text you.</p></div>
          <div class="card"><form method="post">
            <input name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="(919) 555-0123" required>
            <button class="primary">Text me</button></form></div>`,
        `Join ${trip.name} on ${botName}`,
      ),
    );
  });

  app.post("/j/:code", async (c) => {
    const code = c.req.param("code");
    const trip = store.tripByCode(code);
    if (!trip) return c.html(page("Not found", html`<div class="card empty">That invite link doesn't exist.</div>`), 404);
    const form = await c.req.parseBody();
    const phone = toE164(String(form.phone ?? ""));
    if (!phone) return c.html(page("Try again", html`<div class="card empty">That number doesn't look right. <a href="/j/${code}">Try again</a></div>`), 400);
    let result: Awaited<ReturnType<typeof bot.joinByPhone>>;
    try {
      result = await bot.joinByPhone(phone, code);
    } catch (err) {
      console.error("[web] join failed", err);
      return c.html(page("Something broke", html`<div class="card empty">Something went wrong 😬 Try again in a minute.</div>`), 500);
    }
    const where = result.line ? html`<a href="${smsLink(result.line, `JOIN ${trip.code}`)}">${result.line}</a>` : botName;
    return c.html(
      page(
        "You're in",
        html`<div class="hero"><p class="kicker">You're in</p><h1>${trip.name} 🎉</h1>
            <p>${botName} will text you from ${where} in the next minute or two.</p></div>
          <div class="card"><b>Save that number as “${botName}”.</b>
            <p class="muted" style="margin:6px 0 0">If nothing arrives, text <b>JOIN ${trip.code}</b> to it. Then just text receipts.</p>
            ${result.line ? html`<a class="primary" href="${smsLink(result.line, `JOIN ${trip.code}`)}">Open Messages</a>` : ""}</div>
          <p class="muted small" style="text-align:center"><a href="/t/${trip.code}">See the trip so far</a></p>`,
      ),
    );
  });

  // --- Trip page: the shared, auditable view. "Who are you?" personalises it client-side.
  app.get("/t/:code", (c) => {
    const trip = store.tripByCode(c.req.param("code"));
    if (!trip) return c.html(page("Not found", html`<div class="card empty">Trip not found.</div>`), 404);
    const { members, expenses, transfers, net, plan } = tripLedger(store, trip.id);
    const data = {
      code: trip.code,
      name: trip.name,
      members: members.map((m) => ({ id: m.id, name: m.name ?? `•••${m.phone.slice(-4)}` })),
      net: Object.fromEntries(net),
      plan,
      expenses: expenses.map(({ expense: e, shares }) => ({
        id: e.id,
        description: e.description,
        total: e.total_cents,
        payer: e.payer_id,
        date: shortDate(e.created_at),
        receipt: e.has_receipt === 1,
        shares: shares.map((s) => ({ user: s.user_id, cents: s.cents, status: s.status, reason: s.dispute_reason })),
      })),
      transfers: transfers.map((t) => ({ from: t.from_id, to: t.to_id, cents: t.cents, date: shortDate(t.created_at), url: t.tx_sig ? chain.explorerUrl(t.tx_sig) : null })),
    };
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    const total = expenses.reduce((a, { expense }) => a + expense.total_cents, 0);
    return c.html(
      page(
        trip.name,
        html`<div class="hero"><p class="kicker">${botName} · ${members.length} people</p><h1>${trip.name}</h1>
            <p>${fmt(total)} spent across ${expenses.length} expense${expenses.length === 1 ? "" : "s"}.</p></div>
          <h2>Who are you?</h2>
          <div class="chips" id="who"></div>
          <div id="me"></div>
          <h2>Everyone</h2>
          <div id="everyone"></div>
          <h2>Settle up</h2>
          <div id="plan"></div>
          <h2>Expenses</h2>
          <div id="expenses"></div>
          <h2>Payments · Solana devnet</h2>
          <div id="payments"></div>
          <footer class="muted small">Shares count as soon as they're logged. Text <b>DISPUTE</b> + a reason to ${botName} if one is wrong.</footer>
          <script id="data" type="application/json">${raw(json)}</script>
          <script>${raw(TRIP_JS)}</script>`,
        `${trip.name}: who owes what, line by line.`,
      ),
    );
  });

  const server = serve({ fetch: app.fetch, port: opts.port });
  console.log(`[web] listening on http://localhost:${opts.port}`);
  return server;
}

// ---------------------------------------------------------------- trip page script (plain JS, no deps)

const TRIP_JS = String.raw`
(function(){
  var D = JSON.parse(document.getElementById('data').textContent);
  var KEY = 'tab:who:' + D.code;
  var byId = {}; D.members.forEach(function(m){ byId[m.id] = m; });
  var name = function(id){ return (byId[id] || {}).name || 'Someone'; };
  var initial = function(id){ return name(id).trim().charAt(0).toUpperCase() || '?'; };
  var $ = function(s){ return document.querySelector(s); };
  var esc = function(s){ return String(s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
  var fmt = function(c){ var n = Math.abs(c)/100; return (c<0?'-':'') + '$' + n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); };
  var money = function(c){ return c % 100 === 0 ? '$' + (c/100).toLocaleString('en-US') : fmt(c); };

  var me = null;
  try { me = Number(localStorage.getItem(KEY)) || null; } catch (e) {}
  if (me && !byId[me]) me = null;

  function pairs(u){
    return D.members.filter(function(m){ return m.id !== u; }).map(function(m){
      var lines = [], cents = 0;
      D.expenses.forEach(function(e){
        if (e.payer === m.id) {
          var mine = e.shares.filter(function(s){ return s.user === u; })[0];
          if (!mine) return;
          lines.push({e:e, cents:mine.cents, dir:'i_owe', status:mine.status, reason:mine.reason});
          if (mine.status === 'approved') cents += mine.cents;
        } else if (e.payer === u) {
          var theirs = e.shares.filter(function(s){ return s.user === m.id; })[0];
          if (!theirs) return;
          lines.push({e:e, cents:theirs.cents, dir:'they_owe', status:theirs.status, reason:theirs.reason});
          if (theirs.status === 'approved') cents -= theirs.cents;
        }
      });
      var paid = 0, received = 0;
      D.transfers.forEach(function(t){ if (t.from===u && t.to===m.id) paid += t.cents; if (t.from===m.id && t.to===u) received += t.cents; });
      return {other:m.id, cents:cents - paid + received, lines:lines, paid:paid, received:received};
    }).filter(function(p){ return p.cents !== 0 || p.lines.length; });
  }

  function renderWho(){
    $('#who').innerHTML = D.members.map(function(m){
      return '<button class="chip" type="button" data-id="'+m.id+'" aria-pressed="'+(m.id===me)+'">'+esc(m.name)+'</button>';
    }).join('');
    Array.prototype.forEach.call($('#who').children, function(b){
      b.onclick = function(){ me = Number(b.dataset.id); try { localStorage.setItem(KEY, me); } catch (e) {} render(); };
    });
  }

  function renderMe(){
    var el = $('#me');
    if (!me) { el.innerHTML = '<div class="card empty">Tap your name to see your running total and why.</div>'; return; }
    var net = D.net[me] || 0;
    var ps = pairs(me);
    var head = net < 0 ? '<div class="muted small">You owe</div><div class="big neg">'+fmt(-net)+'</div>'
             : net > 0 ? '<div class="muted small">You are owed</div><div class="big pos">'+fmt(net)+'</div>'
             : '<div class="muted small">You are</div><div class="big">all square 🎉</div>';
    var rows = ps.map(function(p){
      var label = p.cents > 0 ? 'you owe <b>'+esc(name(p.other))+'</b>' : p.cents < 0 ? '<b>'+esc(name(p.other))+'</b> owes you' : 'square with <b>'+esc(name(p.other))+'</b>';
      var amt = p.cents > 0 ? '<b class="neg">'+fmt(p.cents)+'</b>' : p.cents < 0 ? '<b class="pos">'+fmt(-p.cents)+'</b>' : '<b>$0.00</b>';
      var lines = p.lines.map(function(l){
        var how = l.e.shares.length > 1 ? money(l.e.total)+' ÷ '+l.e.shares.length : money(l.e.total);
        var who = l.dir === 'i_owe' ? 'you owe' : esc(name(p.other))+' owes you';
        var st = l.status === 'disputed' ? ' <span class="pill disputed">disputed'+(l.reason?': '+esc(l.reason):'')+'</span>' : '';
        return '<div class="line"><span>'+esc(l.e.description)+' <span class="muted">('+how+', '+(l.e.receipt?'🧾':'no receipt')+', '+l.e.date+')</span>'+st+'</span><span class="'+(l.dir==='i_owe'?'neg':'pos')+'">'+who+' '+fmt(l.cents)+'</span></div>';
      });
      if (p.paid) lines.push('<div class="line"><span>You paid '+esc(name(p.other))+'</span><span class="pos">-'+fmt(p.paid)+'</span></div>');
      if (p.received) lines.push('<div class="line"><span>'+esc(name(p.other))+' paid you</span><span class="neg">-'+fmt(p.received)+'</span></div>');
      return '<details><summary><span class="who"><span class="avatar">'+esc(initial(p.other))+'</span><span>'+label+'</span></span>'+amt+'</summary>'+lines.join('')+'</details>';
    }).join('');
    el.innerHTML = '<div class="card">'+head+(rows ? rows : '<p class="muted" style="margin:10px 0 0">Nothing involving you yet.</p>')+'</div>';
  }

  function renderEveryone(){
    $('#everyone').innerHTML = '<div class="card">' + D.members.map(function(m){
      var v = D.net[m.id] || 0;
      var txt = v > 0 ? '<b class="pos">is owed '+fmt(v)+'</b>' : v < 0 ? '<b class="neg">owes '+fmt(-v)+'</b>' : '<b class="muted">square</b>';
      return '<div class="line"><span class="who"><span class="avatar">'+esc(initial(m.id))+'</span>'+esc(m.name)+(m.id===me?' <span class="pill">you</span>':'')+'</span>'+txt+'</div>';
    }).join('') + '</div>';
  }

  function renderPlan(){
    $('#plan').innerHTML = D.plan.length
      ? '<div class="card">' + D.plan.map(function(d){
          return '<div class="line"><span>'+esc(name(d.from))+' → '+esc(name(d.to))+'</span><b>'+fmt(d.cents)+'</b></div>';
        }).join('') + '<p class="muted small" style="margin:10px 0 0">Fewest payments that square everyone. Text <b>PAY</b> to send yours.</p></div>'
      : '<div class="card empty">Nothing to settle 🎉</div>';
  }

  function renderExpenses(){
    var list = D.expenses.slice().reverse();
    $('#expenses').innerHTML = list.length ? list.map(function(e){
      var shares = e.shares.filter(function(s){ return s.user !== e.payer; }).map(function(s){
        var pill = s.status === 'disputed' ? '<span class="pill disputed">disputed'+(s.reason?': '+esc(s.reason):'')+'</span>' : '<span class="pill ok">counted</span>';
        return '<div class="line"><span>'+esc(name(s.user))+(s.user===me?' <span class="muted">(you)</span>':'')+'</span><span>'+fmt(s.cents)+' '+pill+'</span></div>';
      }).join('');
      return '<div class="card"><div class="row"><b>'+esc(e.description)+'</b><b>'+fmt(e.total)+'</b></div>'
        + '<div class="muted small">'+esc(name(e.payer))+' paid · '+e.date+' · '+(e.receipt?'🧾 receipt':'⚠️ no receipt')+'</div>'
        + (shares ? '<details><summary><span class="muted small">Who owes what</span></summary>'+shares+'</details>' : '') + '</div>';
    }).join('') : '<div class="card empty">No expenses yet. Text a receipt to get going.</div>';
  }

  function renderPayments(){
    var list = D.transfers.slice().reverse();
    $('#payments').innerHTML = list.length ? '<div class="card">' + list.map(function(t){
      return '<div class="line"><span>'+esc(name(t.from))+' paid '+esc(name(t.to))+' <b>'+fmt(t.cents)+'</b> <span class="muted">'+t.date+'</span></span>'
        + (t.url ? '<a href="'+esc(t.url)+'" target="_blank" rel="noopener">view ↗</a>' : '') + '</div>';
    }).join('') + '</div>' : '<div class="card empty">No payments yet.</div>';
  }

  function render(){ renderWho(); renderMe(); renderEveryone(); renderPlan(); renderExpenses(); renderPayments(); }
  render();
})();
`;
