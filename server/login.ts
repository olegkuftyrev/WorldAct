import type { NextFunction, Request, Response } from "express";
import { pool, userFields, type User } from "./db.js";
import { createSession, purgeExpiredSessions, verifyPassword } from "./auth.js";
import { profileOptionsSQL } from "./profile-options.js";

// Both the JSON login and public block form share one bounded attempt bucket.
const attempts = new Map<string, { count: number; expires: number }>();
const duration = 15 * 60_000;
export function loginRateLimit(req: Request, res: Response, next: NextFunction) {
  const now = Date.now(), key = req.ip || "unknown";
  if (attempts.size >= 10_000)
    for (const [address, attempt] of attempts)
      if (attempt.expires <= now) attempts.delete(address);
  if (attempts.size >= 10_000 && !attempts.has(key)) {
    res.setHeader("Retry-After", Math.ceil(duration / 1000));
    res.status(429).json({ error: "Too many requests. Please try again later." });
    return;
  }
  let attempt = attempts.get(key);
  if (!attempt || attempt.expires <= now) {
    attempt = { count: 0, expires: now + duration };
    attempts.set(key, attempt);
  }
  if (++attempt.count > 30) {
    res.setHeader("Retry-After", Math.ceil((attempt.expires - now) / 1000));
    res.status(429).json({ error: "Too many requests. Please try again later." });
    return;
  }
  next();
}

export async function authenticateLogin(
  req: Request, res: Response,
  input: { login: string; password: string; remember?: boolean },
): Promise<User | null> {
  const result = await pool.query<User & { password_hash: string }>(
    `SELECT ${userFields}, password_hash FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1) LIMIT 1`,
    [input.login],
  );
  const record = result.rows[0];
  if (!record || !(await verifyPassword(input.password, record.password_hash))) return null;
  const client = await pool.connect();
  let setCookie: (() => unknown) | undefined, user: User | undefined;
  try {
    await client.query("BEGIN");
    // Credential changes and account removal lock this same row before revoking
    // sessions. Recheck the verified snapshot while blocking those changes until
    // the replacement session has committed; never hold the lock during scrypt.
    const current = (await client.query<User & { password_hash: string }>(
      `SELECT ${userFields},${profileOptionsSQL()}, password_hash FROM users WHERE id=$1 FOR SHARE`, [record.id],
    )).rows[0];
    if (!current || current.password_hash !== record.password_hash || ![current.username.toLowerCase(), current.email.toLowerCase()].includes(input.login.toLowerCase())) {
      await client.query("ROLLBACK"); return null;
    }
    const { password_hash: _password, ...account } = current;
    user = account;
    setCookie = await createSession(req, res, user.id, { remember: input.remember, client, deferCookie: true });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23503") return null;
    throw error;
  } finally { client.release(); }
  // Global expired-session cleanup must not hold the account lock while waiting
  // for session rows another login may already own.
  await purgeExpiredSessions();
  setCookie!();
  return user!;
}
