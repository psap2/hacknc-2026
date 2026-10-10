/**
 * Register demo phones with Photon so Tab can text them (Spectrum Pro / shared pool).
 *
 *   npx tsx scripts/register-users.ts +19195550101 +19195550102 ...
 */
import "dotenv/config";
import { createSharedUser } from "../src/messaging/photon-users.js";
import { toE164 } from "../src/messaging/types.js";

const creds = {
  projectId: process.env.SPECTRUM_PROJECT_ID ?? "",
  projectSecret: process.env.SPECTRUM_PROJECT_SECRET ?? "",
};
if (!creds.projectId || !creds.projectSecret) {
  console.error("Set SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET in .env first.");
  process.exit(1);
}

for (const raw of process.argv.slice(2)) {
  const phone = toE164(raw);
  if (!phone) {
    console.error(`skip ${raw}: not a phone number`);
    continue;
  }
  try {
    const u = await createSharedUser(creds, phone);
    console.log(`${phone} -> Tab texts from ${u.assignedPhoneNumber ?? "(shared pool)"}`);
  } catch (err) {
    console.error(`${phone}: ${(err as Error).message}`);
  }
}
