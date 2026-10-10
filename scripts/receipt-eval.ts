/**
 * Run Gemini over receipt photos and check the numbers add up.
 *
 *   npx tsx scripts/receipt-eval.ts samples/*.jpg
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { GeminiAI } from "../src/ai/gemini.js";
import { fmt, receiptLooksConsistent } from "../src/ledger/split.js";

const key = process.env.GEMINI_API_KEY;
if (!key) {
  console.error("Set GEMINI_API_KEY in .env first.");
  process.exit(1);
}
const ai = new GeminiAI(key, process.env.GEMINI_MODEL ?? "gemini-2.5-flash");
const mime: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic" };

let ok = 0;
const files = process.argv.slice(2);
for (const file of files) {
  const started = Date.now();
  let r;
  try {
    r = await ai.readReceipt({ bytes: await readFile(file), mimeType: mime[extname(file).toLowerCase()] ?? "image/jpeg" });
  } catch (err) {
    const e = err as { status?: number; message?: string };
    console.log(`✗ ${file}: Gemini error${e.status ? ` ${e.status}` : ""}: ${(e.message ?? String(err)).slice(0, 200)}`);
    continue;
  }
  const ms = Date.now() - started;
  if (!r) {
    console.log(`✗ ${file}: not recognized as a receipt (${ms}ms)`);
    continue;
  }
  const good = receiptLooksConsistent(r);
  if (good) ok++;
  console.log(`${good ? "✓" : "✗"} ${file}: ${r.merchant} ${fmt(r.total_cents)} · ${r.items.length} items · tax ${fmt(r.tax_cents)} tip ${fmt(r.tip_cents)} (${ms}ms)`);
  for (const it of r.items) console.log(`    ${it.qty}× ${it.name} ${fmt(it.price_cents)}`);
}
console.log(`\n${ok}/${files.length} receipts add up.`);
