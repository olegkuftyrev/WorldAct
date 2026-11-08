import { Router } from "express";
import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, getSettings, userFields } from "./db.js";
import { requireRole, assertActiveAccountAuthentication, type AuthRequest } from "./auth.js";
import { needUser, HttpError } from "./utils.js";
import { queueMail, deliverMail } from "./accounts.js";

const router = Router(), auth = requireRole("administrator", "editor", "author", "contributor", "subscriber");
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/, "This confirmation link is invalid.");
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const expired = () => new HttpError(410, "This email confirmation has expired, was replaced, or was already used.");
export async function pendingProfileEmail(userId: number, db: Pick<PoolClient, "query"> = pool) {
  return (await db.query('SELECT email,created_at AS "createdAt",expires_at AS "expiresAt",expires_at<=now() AS expired FROM user_email_changes WHERE user_id=$1', [userId])).rows[0] || null;
}
export async function assertAvailableProfileEmail(db: PoolClient, userId: number, email: string) {
  if ((await db.query("SELECT id FROM users WHERE id<>$1 AND (lower(email)=lower($2) OR lower(username)=lower($2))", [userId, email])).rowCount)
    throw new HttpError(409, "That email address is already registered.");
}
/** Caller holds the target user, then the shared account-identity advisory lock. */
export async function queueProfileEmailChange(db: PoolClient, user: { id: number; email: string; username: string }, email: string, resend = false) {
  email = email.toLowerCase();
  if (email === user.email.toLowerCase()) return null;
  await assertAvailableProfileEmail(db, user.id, email);
  const previous = await pendingProfileEmail(user.id, db);
  if (previous?.email === email && !previous.expired && !resend) return null;
  const token = randomBytes(32).toString("hex"), settings = await getSettings(db);
  const link = new URL("/confirm-profile-email?token=" + token, process.env.APP_ORIGIN || "http://127.0.0.1:5173").href;
  await db.query("INSERT INTO user_email_changes(user_id,email,previous_email,token_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '24 hours') ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,previous_email=excluded.previous_email,token_hash=excluded.token_hash,created_at=now(),expires_at=excluded.expires_at", [user.id, email, user.email.toLowerCase(), hash(token)]);
  return queueMail(db, email, `Confirm your email change for ${settings.siteTitle}`, `Hello ${user.username},\n\nYou requested to change the email address on your ${settings.siteTitle} account to ${email}.\n\nSign in to the same account, then review and confirm within 24 hours:\n${link}\n\nOpening this link does not change the address. Ignore this message if you did not request the change.`);
}
async function withUser<T>(req: AuthRequest, work: (db: PoolClient, user: { id: number; email: string; username: string }) => Promise<T>) {
  const userId = needUser(req).id;
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const user = (await db.query("SELECT id,email,username FROM users WHERE id=$1 FOR UPDATE", [userId])).rows[0];
    if (!user) throw expired();
    await assertActiveAccountAuthentication(req, db);
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldact-account-identity'))");
    const result = await work(db, user); await db.query("COMMIT"); return result;
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
}
router.get("/profile/email", auth, async (req: AuthRequest, res) => res.json({ pending: await pendingProfileEmail(needUser(req).id) }));
router.delete("/profile/email", auth, async (req: AuthRequest, res) => {
  await withUser(req, async db => { await db.query("DELETE FROM user_email_changes WHERE user_id=$1", [needUser(req).id]); });
  res.json({ ok: true, pending: null });
});
router.post("/profile/email/resend", auth, async (req: AuthRequest, res) => {
  z.object({}).strict().parse(req.body || {});
  const userId = needUser(req).id;
  const mail = await withUser(req, async (db, user) => {
    const pending = await pendingProfileEmail(userId, db); if (!pending) throw new HttpError(404, "There is no pending email change.");
    return queueProfileEmailChange(db, user, pending.email, true);
  });
  res.json({ pending: await pendingProfileEmail(userId), delivery: await deliverMail(mail) });
});
router.get("/profile/email/confirmation", auth, async (req: AuthRequest, res) => {
  const token = tokenSchema.parse(req.query.token);
  const pending = (await pool.query('SELECT change.email,change.expires_at AS "expiresAt" FROM user_email_changes change JOIN users u ON u.id=change.user_id AND lower(u.email)=change.previous_email WHERE change.user_id=$1 AND change.token_hash=$2 AND change.expires_at>now()', [needUser(req).id, hash(token)])).rows[0];
  if (!pending) throw expired();
  res.json({ ...pending, siteTitle: (await getSettings()).siteTitle });
});
router.post("/profile/email/confirmation", auth, async (req: AuthRequest, res) => {
  const { token } = z.object({ token: tokenSchema }).strict().parse(req.body), userId = needUser(req).id;
  const result = await withUser(req, async (db, user) => {
    const pending = (await db.query("DELETE FROM user_email_changes WHERE user_id=$1 AND token_hash=$2 AND previous_email=lower($3) AND expires_at>now() RETURNING email", [userId, hash(token), user.email])).rows[0];
    if (!pending) throw expired();
    if ((await db.query("SELECT id FROM users WHERE id<>$1 AND (lower(email)=lower($2) OR lower(username)=lower($2))", [userId, pending.email])).rowCount) return { conflict: true, mail: null, user: null };
    await db.query("UPDATE users SET email=$1 WHERE id=$2", [pending.email, userId]);
    // Reset links sent to the previous address no longer authorize this identity.
    await db.query("DELETE FROM password_resets WHERE user_id=$1", [userId]);
    const settings = await getSettings(db), mail = await queueMail(db, user.email, `Your email changed for ${settings.siteTitle}`, `The email address for your ${settings.siteTitle} account (${user.username}) changed to ${pending.email}.\n\nIf this was unexpected, sign in and review your profile or contact a site administrator.`);
    return { conflict: false, mail, user: (await db.query(`SELECT ${userFields} FROM users WHERE id=$1`, [userId])).rows[0] };
  });
  if (result.conflict) throw new HttpError(409, "That email address is already registered. Request a different address from your profile.");
  res.json({ ok: true, user: result.user, pending: null, delivery: await deliverMail(result.mail) });
});
export default router;
