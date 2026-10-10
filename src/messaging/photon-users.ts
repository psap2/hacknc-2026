/**
 * Spectrum Users REST API. On Free/Pro (shared pool) a person must be registered
 * as a project user before the agent can message them.
 * Docs: https://photon.codes/docs/api-reference/users/create-user
 */
const BASE = "https://spectrum.photon.codes";

export interface PhotonUser {
  id: string;
  phoneNumber: string;
  assignedPhoneNumber?: string | null;
  type: "shared" | "dedicated";
}

export async function createSharedUser(
  creds: { projectId: string; projectSecret: string },
  phone: string,
  firstName?: string,
): Promise<PhotonUser> {
  const auth = Buffer.from(`${creds.projectId}:${creds.projectSecret}`).toString("base64");
  const res = await fetch(`${BASE}/projects/${creds.projectId}/users/`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "shared", phoneNumber: phone, ...(firstName ? { firstName } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as { succeed?: boolean; data?: PhotonUser; message?: string };
  if (!res.ok || !body.data) {
    throw new Error(`Photon create user failed (${res.status}): ${body.message ?? JSON.stringify(body)}`);
  }
  return body.data;
}
