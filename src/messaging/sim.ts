import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { createInterface } from "node:readline";
import type { InboundHandler, Messenger } from "./types.js";

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
};

/**
 * Local multi-person simulator so the team can develop without phones.
 *
 *   amit: new trip Asheville
 *   jake: join ASHE42
 *   amit: [img samples/gas.jpg] gas, everyone
 *
 * Each name gets a stable fake phone number (+1555000xxxx).
 */
export class SimMessenger implements Messenger {
  private phones = new Map<string, string>();
  private names = new Map<string, string>();
  private rl: ReturnType<typeof createInterface> | undefined;

  phoneFor(name: string): string {
    const key = name.toLowerCase();
    let phone = this.phones.get(key);
    if (!phone) {
      phone = `+1555000${String(1000 + this.phones.size).slice(-4)}`;
      this.phones.set(key, phone);
      this.names.set(phone, key);
    }
    return phone;
  }

  async start(handler: InboundHandler): Promise<void> {
    console.log('Simulator ready. Type "<person>: <message>", or "<person>: [img path/to/receipt.jpg] caption".');
    this.rl = createInterface({ input: process.stdin, prompt: "> " });
    this.rl.prompt();
    this.rl.on("line", async (line) => {
      const m = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
      if (!m) {
        if (line.trim()) console.log('  (format: "name: message")');
        this.rl?.prompt();
        return;
      }
      const [, who, rest] = m as unknown as [string, string, string];
      const images = [];
      let text = rest;
      for (const img of rest.matchAll(/\[img\s+([^\]]+)\]/g)) {
        const path = img[1]!.trim();
        try {
          images.push({ bytes: await readFile(path), mimeType: MIME[extname(path).toLowerCase()] ?? "image/jpeg" });
        } catch {
          console.log(`  (couldn't read ${path})`);
        }
        text = text.replace(img[0], "");
      }
      try {
        await handler({ phone: this.phoneFor(who), text: text.trim(), images });
      } catch (err) {
        console.error("  handler error:", err);
      }
      this.rl?.prompt();
    });
  }

  async send(phone: string, text: string): Promise<void> {
    const who = this.names.get(phone) ?? phone;
    const indented = text.split("\n").join("\n      ");
    console.log(`  📱 → ${who}: ${indented}`);
  }

  async register(phone: string): Promise<void> {
    if (!this.names.has(phone)) this.names.set(phone, phone);
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
