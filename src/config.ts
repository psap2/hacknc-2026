import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

const demo = process.env.DEMO_MODE === "1";

export const config = {
  demo,
  botName: process.env.BOT_NAME ?? "Tab",
  dbPath: process.env.DB_PATH ?? "data/tab.db",
  publicUrl: (process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  port: num("PORT", 3000),
  /** "spectrum" talks to real iMessage; "sim" is the local multi-user simulator. */
  messenger: (process.env.MESSENGER ?? "sim") as "spectrum" | "sim",
  /** Number friends text in the sms: invite link. Only meaningful on a dedicated line. */
  botPhone: process.env.BOT_PHONE ?? "",

  spectrum: {
    projectId: process.env.SPECTRUM_PROJECT_ID ?? "",
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET ?? "",
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  },

  solana: {
    /** "devnet" sends real devnet transactions; "mock" fakes them (no network). */
    mode: (process.env.SOLANA_MODE ?? "mock") as "devnet" | "mock",
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    treasurySecret: process.env.TAB_TREASURY_SECRET ?? "",
    mint: process.env.TAB_USDC_MINT ?? "",
    masterKeyHex: process.env.TAB_MASTER_KEY ?? "",
    startingBalanceCents: num("STARTING_BALANCE_CENTS", 500_00),
  },

  /** Receipt-backed shares auto-approve after this long. No-receipt shares never do. */
  autoApproveMs: num("AUTO_APPROVE_MINUTES", demo ? 5 : 48 * 60) * 60_000,
  /** Minimum gap between reminders for the same person. */
  reminderGapMs: num("REMINDER_GAP_MINUTES", demo ? 3 : 24 * 60) * 60_000,
  /** How often the background job runs. */
  jobIntervalMs: num("JOB_INTERVAL_SECONDS", demo ? 30 : 15 * 60) * 1000,
};
