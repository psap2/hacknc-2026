import { Tab } from "./agent/bot.js";
import { GeminiAI } from "./ai/gemini.js";
import { HeuristicAI } from "./ai/heuristic.js";
import type { AI } from "./ai/types.js";
import { config } from "./config.js";
import { openDb, Store } from "./ledger/db.js";
import { SimMessenger } from "./messaging/sim.js";
import { SpectrumMessenger } from "./messaging/spectrum.js";
import type { Messenger } from "./messaging/types.js";
import { type Chain, MockChain } from "./solana/chain.js";
import { DevnetChain } from "./solana/devnet.js";
import { startWeb } from "./web/server.js";

const store = new Store(openDb(config.dbPath));

const ai: AI = config.gemini.apiKey ? new GeminiAI(config.gemini.apiKey, config.gemini.model) : new HeuristicAI();
if (!config.gemini.apiKey) console.warn("[ai] GEMINI_API_KEY not set: receipts can't be read, using keyword parsing for text.");

const chain: Chain =
  config.solana.mode === "devnet"
    ? new DevnetChain({
        rpcUrl: config.solana.rpcUrl,
        treasurySecret: config.solana.treasurySecret,
        mint: config.solana.mint,
        masterKeyHex: config.solana.masterKeyHex,
      })
    : new MockChain();

const messenger: Messenger =
  config.messenger === "spectrum" ? new SpectrumMessenger(config.spectrum) : new SimMessenger();

const bot = new Tab({
  store,
  messenger,
  ai,
  chain,
  config: {
    botName: config.botName,
    publicUrl: config.publicUrl,
    botPhone: config.botPhone,
    startingBalanceCents: config.solana.startingBalanceCents,
    autoApproveMs: config.autoApproveMs,
    reminderGapMs: config.reminderGapMs,
  },
});

console.log(`[tab] messenger=${config.messenger} chain=${chain.label} ai=${ai.constructor.name} demo=${config.demo}`);
startWeb({ store, bot, chain, port: config.port, botName: config.botName });
await messenger.start((msg) => bot.handle(msg));

setInterval(() => {
  bot.runJobs().catch((err) => console.error("[jobs] failed", err));
}, config.jobIntervalMs);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    await messenger.stop();
    store.db.close();
    process.exit(0);
  });
}
