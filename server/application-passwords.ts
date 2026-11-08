import express, { type Response } from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { pool } from "./db.js";
import { type AuthRequest } from "./auth.js";
import { HttpError, needUser, parseId, plainText } from "./utils.js";

const router = express.Router();
const columns = `uuid,app_id AS "appId",name,created_at AS created,last_used AS "lastUsed",last_ip AS "lastIp"`;
const restRecord = (item: any) => ({ uuid: item.uuid, app_id: item.appId, name: item.name, created: item.created, last_used: item.lastUsed, last_ip: item.lastIp });
function targetUser(req: AuthRequest) {
  const user = needUser(req);
  const value = req.params.userId;
  const target = !value || value === "me" ? user.id : parseId(value);
  if (target !== user.id && user.role !== "administrator")
    throw new HttpError(403, "You cannot manage this user's application passwords.");
  return target;
}
const isRest = (req: AuthRequest) => req.originalUrl.startsWith("/wp-json/");
async function exists(userId: number) {
  if (!(await pool.query("SELECT 1 FROM users WHERE id=$1", [userId])).rowCount)
    throw new HttpError(404, "User not found.");
}
for (const base of ["/api/profile/application-passwords", "/api/users/:userId/application-passwords", "/wp-json/wp/v2/users/:userId/application-passwords"]) {
  router.get(base, async (req: AuthRequest, res) => {
    const userId = targetUser(req);
    await exists(userId);
    const records = (await pool.query(`SELECT ${columns} FROM application_passwords WHERE user_id=$1 ORDER BY created_at DESC,uuid`, [userId])).rows;
    res.json(isRest(req) ? records.map(restRecord) : { passwords: records });
  });
  router.post(base, async (req: AuthRequest, res) => {
    const userId = targetUser(req);
    await exists(userId);
    const input = z.object({ name: z.string().trim().min(1).max(200), app_id: z.uuid().nullable().optional() }).strict().parse(req.body);
    const name = plainText(input.name).trim();
    if (!name) throw new HttpError(400, "Enter an application name.");
    const key = randomBytes(24).toString("base64url"), uuid = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('application-passwords'),$1)", [userId]);
      const current = await client.query("SELECT name FROM application_passwords WHERE user_id=$1", [userId]);
      if (current.rowCount! >= 100) throw new HttpError(400, "Revoke an existing application password before adding another.");
      if (current.rows.some(item => item.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, "An application password with this name already exists.");
      const record = (await client.query(`INSERT INTO application_passwords(uuid,user_id,app_id,name,key_hash) VALUES($1,$2,$3,$4,$5) RETURNING ${columns}`, [uuid,userId,input.app_id || null,name,createHash("sha256").update(key).digest("hex")])).rows[0];
      await client.query("COMMIT");
      const password = key.match(/.{1,4}/g)!.join(" ");
      res.status(201).json(isRest(req) ? { ...restRecord(record), password } : { applicationPassword: record, password });
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  });
  router.get(base + "/introspect", async (req: AuthRequest, res) => {
    const userId = targetUser(req);
    if (!req.applicationPasswordUuid) throw new HttpError(404, "This request did not use an application password.");
    const record = (await pool.query(`SELECT ${columns} FROM application_passwords WHERE user_id=$1 AND uuid=$2`, [userId,req.applicationPasswordUuid])).rows[0];
    if (!record) throw new HttpError(404, "Application password not found.");
    res.json(isRest(req) ? restRecord(record) : { applicationPassword: record });
  });
  router.delete(base, async (req: AuthRequest, res) => {
    const userId = targetUser(req); await exists(userId);
    const result = await pool.query("DELETE FROM application_passwords WHERE user_id=$1", [userId]);
    res.json(isRest(req) ? { deleted: true, count: result.rowCount } : { ok: true, count: result.rowCount });
  });
  router.get(base + "/:uuid", async (req: AuthRequest, res) => {
    const userId = targetUser(req), uuid = z.uuid().parse(req.params.uuid);
    const record = (await pool.query(`SELECT ${columns} FROM application_passwords WHERE user_id=$1 AND uuid=$2`, [userId,uuid])).rows[0];
    if (!record) throw new HttpError(404, "Application password not found.");
    res.json(isRest(req) ? restRecord(record) : { applicationPassword: record });
  });
  const update = async (req: AuthRequest, res: Response) => {
    const userId = targetUser(req), uuid = z.uuid().parse(req.params.uuid);
    const input = z.object({ name: z.string().trim().min(1).max(200) }).strict().parse(req.body);
    const name = plainText(input.name).trim();
    if (!name) throw new HttpError(400, "Enter an application name.");
    const record = (await pool.query(`UPDATE application_passwords SET name=$3 WHERE user_id=$1 AND uuid=$2 RETURNING ${columns}`, [userId,uuid,name])).rows[0];
    if (!record) throw new HttpError(404, "Application password not found.");
    res.json(isRest(req) ? restRecord(record) : { applicationPassword: record });
  };
  router.put(base + "/:uuid", update);
  router.post(base + "/:uuid", update);
  router.delete(base + "/:uuid", async (req: AuthRequest, res) => {
    const userId = targetUser(req), uuid = z.uuid().parse(req.params.uuid);
    const record = (await pool.query(`DELETE FROM application_passwords WHERE user_id=$1 AND uuid=$2 RETURNING ${columns}`, [userId,uuid])).rows[0];
    if (!record) throw new HttpError(404, "Application password not found.");
    res.json(isRest(req) ? { deleted: true, previous: restRecord(record) } : { ok: true });
  });
}
export default router;
