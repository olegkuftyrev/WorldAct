import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pool, defaultSettings, userFields } from "./db.js";
import { hashPassword } from "./auth.js";
import { seedInitialContent } from "./initial-content.js";
import { HttpError, plainText } from "./utils.js";
import { queueMail, deliverMail } from "./accounts.js";
import { isInstalled } from "./installation-state.js";
export { isInstalled } from "./installation-state.js";

const router = Router();
const inputSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  siteTitle: z.string().trim().min(1).max(150),
  username: z.string().trim().min(1).max(60).regex(/^[a-zA-Z0-9_.@-]+$/),
  email: z.email().max(254),
  password: z.string().min(12).max(1024),
  discourageSearchEngines: z.boolean().default(false),
}).strict();
function configuredToken() {
  const token = process.env.WORLDACT_INSTALL_TOKEN || "";
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export function installationTokenMatches(input: string, expected = configuredToken()) {
  if (!expected || !/^[a-f0-9]{64}$/.test(input)) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(input), digest(expected));
}
router.get("/install", async (_req, res) => {
  const installed = await isInstalled();
  res.json({ installed, available: !installed && configuredToken() !== null, language: "en_US" });
});
router.post("/install", async (req, res) => {
  const input = inputSchema.parse(req.body);
  if (!installationTokenMatches(input.token)) throw new HttpError(403, "Open the installation link created on this server to continue.");
  const siteTitle = plainText(input.siteTitle).trim();
  if (!siteTitle) throw new HttpError(400, "Enter a site title.");
  // No password work or account creation is allowed without the local bootstrap token.
  const passwordHash = await hashPassword(input.password), client = await pool.connect();
  let user, mail: Awaited<ReturnType<typeof queueMail>> | null = null;
  try {
    await client.query("BEGIN");
    // CLI seed uses this same lock. Any concurrent seed/install wins once.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-seed'))");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-account-identity'))");
    if (await isInstalled(client)) throw new HttpError(409, "WorldAct is already installed. Sign in to your existing account.");
    user = (await client.query(`INSERT INTO users(username,email,display_name,password_hash,role) VALUES($1,$2,$1,$3,'administrator') RETURNING ${userFields}`, [input.username, input.email.toLowerCase(), passwordHash])).rows[0];
    await client.query("INSERT INTO settings(id,data) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [JSON.stringify({ ...defaultSettings, siteTitle, siteUrl: new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin, adminEmail: input.email.toLowerCase(), discourageSearchEngines: input.discourageSearchEngines })]);
    await seedInitialContent(client, user.id);
    await client.query("INSERT INTO seed_markers(name) VALUES('browser-install-v1')");
    mail = await queueMail(client, input.email.toLowerCase(), `${siteTitle}: your new WorldAct site`, `Your new WorldAct site is ready.\n\nSite: ${new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin}\nUsername: ${input.username}\nSign in using the password you chose during installation.\n\nSign in: ${new URL("/login", process.env.APP_ORIGIN || "http://127.0.0.1:5173").href}`);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
  res.status(201).json({ installed: true, user, loginUrl: "/login", delivery: await deliverMail(mail) });
});
export default router;
