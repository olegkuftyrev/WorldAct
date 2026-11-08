import { Router } from "express";
import { z } from "zod";
import { pool } from "./db.js";
import { requireRole } from "./auth.js";
import { akismetKey, readAkismetSecretStatus, updateAkismetConfiguration, verifyAkismetKey } from "./bundled-plugins.js";

export async function readAkismetConnector() {
  const plugin = (await pool.query("SELECT enabled,settings FROM extensions WHERE slug='akismet'")).rows[0];
  const status = await readAkismetSecretStatus();
  const active = Boolean(plugin?.enabled), sendComments = Boolean(plugin?.settings?.sendComments);
  return {
    id: "akismet", name: "Akismet", description: "Protect your site from spam with Akismet Anti-spam.",
    authenticationMethod: "api_key", pluginSlug: "akismet",
    installed: Boolean(plugin), active, sendComments,
    connected: active && sendComments && status.apiKeyConfigured && status.keyVerified,
    keySource: status.apiKeyConfigured ? "database" : null,
    ...status,
  };
}
const router = Router(), admin = requireRole("administrator");
router.get("/connectors", admin, async (_req, res) => {
  res.json({ connectors: [await readAkismetConnector()] });
});
router.put("/connectors/akismet", admin, async (req, res) => {
  const input = z.object({
    apiKey: akismetKey.optional(), clearApiKey: z.boolean().optional(), sendComments: z.boolean().optional(),
  }).strict().parse(req.body);
  await updateAkismetConfiguration(req, {
    apiKey: input.apiKey, clearApiKey: input.clearApiKey,
    ...(input.sendComments === undefined ? {} : { settings: { sendComments: input.sendComments } }),
  }, true);
  res.json({ connector: await readAkismetConnector() });
});
router.post("/connectors/akismet/verify", admin, async (req, res) => {
  z.object({}).strict().parse(req.body || {});
  const verification = await verifyAkismetKey(req);
  res.json({ ...verification, connector: await readAkismetConnector() });
});
export default router;
