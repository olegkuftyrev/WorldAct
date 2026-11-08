import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import type { PoolClient } from "pg";
import { pool, userFields, type Role, type User } from "./db.js";
import { HttpError } from "./utils.js";

const scryptAsync = promisify(scrypt);
const COOKIE = "worldact_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
export interface AuthRequest extends Request {
  user?: User;
  authChecked?: boolean;
  authenticationMethod?: "session" | "application-password";
  applicationPasswordUuid?: string;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt:${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  hash: string,
): Promise<boolean> {
  const [algorithm, salt, encoded] = hash.split(":");
  if (algorithm !== "scrypt" || !salt || !encoded) return false;
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  const stored = Buffer.from(encoded, "hex");
  return stored.length === key.length && timingSafeEqual(stored, key);
}
function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
function readToken(req: Request) {
  const item = req.headers.cookie
    ?.split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(`${COOKIE}=`));
  const token = item?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
/** Recheck a waiting mutation after locking its actor, before changing identity. */
export async function assertActiveAccountAuthentication(req: AuthRequest, db: PoolClient) {
  const userId = req.user?.id;
  const exists = req.authenticationMethod === "application-password"
    ? await db.query("SELECT 1 FROM application_passwords WHERE user_id=$1 AND uuid=$2", [userId, req.applicationPasswordUuid])
    : await db.query("SELECT 1 FROM sessions WHERE user_id=$1 AND token_hash=$2 AND expires_at>now()", [userId, tokenHash(readToken(req) || "")]);
  if (!exists.rowCount) throw new HttpError(401, "Your sign-in has expired. Sign in again to update this account.");
}
export async function attachUser(
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
) {
  try {
    if (req.authChecked) { next(); return; }
    req.authChecked = true;
    const authorization = req.headers.authorization;
    const basic = authorization?.match(/^Basic\s+(.*)$/i);
    if (basic) {
      const encoded = basic[1];
      const credentials = encoded.length <= 1024 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
        ? Buffer.from(encoded, "base64").toString("utf8") : "";
      const separator = credentials.indexOf(":"),
        login = credentials.slice(0, separator).trim(),
        secret = credentials.slice(separator + 1).replace(/\s/g, "");
      if (separator > 0 && login.length <= 254 && /^[A-Za-z0-9_-]{32}$/.test(secret)) {
        const result = await pool.query<User & { uuid: string }>(
          `SELECT ${userFields.split(",").map(field => `u.${field.trim()}`).join(", ")},a.uuid
           FROM users u JOIN application_passwords a ON a.user_id=u.id
           WHERE a.key_hash=$1 AND (lower(u.username)=lower($2) OR lower(u.email)=lower($2))`,
          [tokenHash(secret), login],
        );
        const account = result.rows[0];
        if (account) {
          const { uuid, ...user } = account;
          req.user = user;
          req.authenticationMethod = "application-password";
          req.applicationPasswordUuid = uuid;
          await pool.query("UPDATE application_passwords SET last_used=now(),last_ip=$2 WHERE uuid=$1", [uuid, (req.ip || "").slice(0, 100)]);
          next(); return;
        }
      }
      _res.status(401).json({ error: "The application password is invalid or has been revoked.", code: "invalid_application_password", data: { status: 401 } });
      return;
    }
    const token = readToken(req);
    if (token) {
      const result = await pool.query<User>(
        `SELECT ${userFields
          .split(",")
          .map((field) => `u.${field.trim()}`)
          .join(", ")}
        FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [tokenHash(token)],
      );
      req.user = result.rows[0];
      if (req.user) req.authenticationMethod = "session";
    }
    next();
  } catch (error) {
    next(error);
  }
}
export async function createSession(
  req: Request,
  res: Response,
  userId: number,
  options: { remember?: boolean; client?: PoolClient; deferCookie?: boolean } = {},
) {
  const seconds = options.remember === undefined ? SESSION_SECONDS : 60 * 60 * 24 * (options.remember ? 14 : 2);
  const db = options.client || pool;
  const existingToken = readToken(req);
  if (existingToken)
    await db.query("DELETE FROM sessions WHERE token_hash = $1", [
      tokenHash(existingToken),
    ]);
  const token = randomBytes(32).toString("hex");
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second')`,
    [tokenHash(token), userId, seconds],
  );
  // The caller holding a user lock performs global cleanup after committing.
  if (!options.client) await purgeExpiredSessions();
  const setCookie = () => res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    ...(options.remember === false ? {} : { maxAge: seconds * 1000 }),
  });
  if (!options.deferCookie) setCookie();
  return setCookie;
}
export async function purgeExpiredSessions() {
  await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
}
export async function destroySession(req: Request, res: Response) {
  const token = readToken(req);
  if (token)
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [
      tokenHash(token),
    ]);
  res.clearCookie(COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}
export function requireAuth(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    res.status(401).json({ error: "Please log in to continue." });
    return;
  }
  next();
}
export function requireRole(...roles: Role[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: "Please log in to continue." });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res
        .status(403)
        .json({ error: "You do not have permission to perform this action." });
      return;
    }
    next();
  };
}
