import { Spectrum, type Message, type Space } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers";
import { createSharedUser } from "./photon-users.js";
import type { Inbound, InboundHandler, Messenger } from "./types.js";

/** Text and photos sent together arrive as separate messages; wait this long to merge them. */
const MERGE_WINDOW_MS = 1500;

type SpectrumApp = Awaited<ReturnType<typeof Spectrum>>;

export class SpectrumMessenger implements Messenger {
  private app: SpectrumApp | undefined;
  private spaces = new Map<string, Space>();
  private buffers = new Map<string, { msg: Inbound; timer: NodeJS.Timeout }>();
  private registered = new Set<string>();

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
    await space.send(text);
  }

  async register(phone: string, name?: string): Promise<void> {
    if (this.registered.has(phone)) return;
    const user = await createSharedUser(this.creds, phone, name);
    this.registered.add(phone);
    console.log(`[spectrum] registered ${phone} (line ${user.assignedPhoneNumber ?? "shared"})`);
  }

  async stop(): Promise<void> {
    await this.app?.stop();
  }
}
