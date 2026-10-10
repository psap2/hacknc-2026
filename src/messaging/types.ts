export interface InboundImage {
  bytes: Buffer;
  mimeType: string;
}

/** One logical message from a person: text and photos sent together are merged. */
export interface Inbound {
  phone: string; // E.164, e.g. "+15551234567"
  text: string;
  images: InboundImage[];
}

export type InboundHandler = (msg: Inbound) => Promise<void>;

/**
 * Everything the bot needs from a chat platform. Tab only ever talks to people
 * 1:1 (Spectrum Pro shared pool has no group chats), so this is just DMs.
 */
export interface Messenger {
  start(handler: InboundHandler): Promise<void>;
  send(phone: string, text: string): Promise<void>;
  /** Make sure the platform will let us message this number (Photon user registration). */
  register(phone: string, name?: string): Promise<void>;
  stop(): Promise<void>;
}

/** Normalize US-centric user input to E.164. Returns null if it doesn't look like a phone number. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
