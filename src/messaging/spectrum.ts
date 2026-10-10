import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers";
import { createSharedUser } from "./photon-users.js";
import type { Inbound, InboundHandler, Messenger } from "./types.js";

/** Text and photos sent together arrive as separate messages; wait this long to merge them. */
const MERGE_WINDOW_MS = 1500;
/**
 * Photon's gateway takes a minute or two to accept a person after the Users API registers
 * them; until then every send fails with "Target not allowed for this project". Retry on that
 * with these gaps (about two minutes total) before giving up.
 */
const NOT_ALLOWED_RETRY_MS = [5_000, 15_000, 30_000, 60_000];
const isNotAllowed = (err: unknown) => /Target not allowed/i.test((err as Error)?.message ?? "");

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

export class SpectrumMessenger implements Messenger {
  private app: SpectrumApp | undefined;
  private spaces = new Map<string, Space>();
  private buffers = new Map<string, { msg: Inbound; timer: NodeJS.Timeout }>();
  /** phone -> the Photon line assigned to that person (Pro shared pool gives each person their own). */
  private lines = new Map<string, string | undefined>();

  constructor(private readonly creds: { projectId: string; projectSecret: string }) {}

  async start(handler: InboundHandler): Promise<void> {
    const app = await Spectrum({
      projectId: this.creds.projectId,
      projectSecret: this.creds.projectSecret,
      providers: [imessage.config()],
      options: { flattenGroups: true },
    });
    this.app = app;
    console.log("[spectrum] connected, listening for iMessages");

    void (async () => {
      for await (const [space, message] of app.messages) {
        try {
          await this.accept(space, message, handler);
        } catch (err) {
          console.error("[spectrum] failed to process message", err);
        }
      }
    })();
  }

  private async accept(space: Space, message: Message, handler: InboundHandler) {
    if (message.direction !== "inbound") return;
    const phone = message.sender?.id;
    if (!phone) return;
    this.spaces.set(phone, space);

    const part: Inbound = { phone, text: "", images: [] };
    const c = message.content;
    if (c.type === "text") part.text = c.text;
    else if (c.type === "attachment" && c.mimeType.startsWith("image/")) {
      part.images.push({ bytes: await c.read(), mimeType: c.mimeType });
    } else return; // reactions, typing, read receipts, etc.

    const existing = this.buffers.get(phone);
    if (existing) {
      clearTimeout(existing.timer);
      existing.msg.text = [existing.msg.text, part.text].filter(Boolean).join(" ");
      existing.msg.images.push(...part.images);
    }
    const msg = existing?.msg ?? part;
    const timer = setTimeout(() => {
      this.buffers.delete(phone);
      handler(msg).catch((err) => console.error("[spectrum] handler error", err));
    }, MERGE_WINDOW_MS);
    this.buffers.set(phone, { msg, timer });
  }

  async send(phone: string, text: string): Promise<void> {
    if (!this.app) throw new Error("SpectrumMessenger.send called before start()");
    let space = this.spaces.get(phone);
    if (!space) {
      space = await imessage(this.app).space.create(phone);
      this.spaces.set(phone, space);
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await space.send(text);
        return;
      } catch (err) {
        const wait = NOT_ALLOWED_RETRY_MS[attempt];
        if (!isNotAllowed(err) || wait === undefined) throw err;
        console.warn(`[spectrum] ${phone} not allowed yet; retrying in ${wait / 1000}s (attempt ${attempt + 1})`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  async register(phone: string, name?: string): Promise<string | undefined> {
    if (this.lines.has(phone)) return this.lines.get(phone);
    const user = await createSharedUser(this.creds, phone, name);
    const line = user.assignedPhoneNumber ?? undefined;
    this.lines.set(phone, line);
    console.log(`[spectrum] registered ${phone} (line ${line ?? "shared"})`);
    return line;
  }

  async stop(): Promise<void> {
    await this.app?.stop();
  }
}
