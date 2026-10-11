import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A short, unguessable "this link is for you" token. Tab adds it to trip-page links it texts to
 * a specific person, so the page opens on them instead of asking "Who are you?". The forwarded
 * invite link never carries one. Not a login: it only picks the default view.
 */
export function viewerToken(secret: string, tripId: number, userId: number): string {
  return createHmac("sha256", secret).update(`${tripId}:${userId}`).digest("hex").slice(0, 16);
}

export function viewerFromToken(secret: string, tripId: number, memberIds: number[], token: string | undefined): number | null {
  if (!token || !/^[0-9a-f]{16}$/.test(token)) return null;
  const given = Buffer.from(token, "hex");
  for (const id of memberIds) {
    const want = Buffer.from(viewerToken(secret, tripId, id), "hex");
    if (timingSafeEqual(given, want)) return id;
  }
  return null;
}
