import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { pool, userFields, type Role, type User } from "./db.js";

const scryptAsync = promisify(scrypt);
const COOKIE = "worldact_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;
export interface AuthRequest extends Request {
  user?: User;
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
export async function attachUser(
  req: AuthRequest,
  _res: Response,
  next: NextFunction,
) {
  try {
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
) {
  const existingToken = readToken(req);
  if (existingToken)
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [
      tokenHash(existingToken),
    ]);
  const token = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')`,
    [tokenHash(token), userId],
  );
  await pool.query("DELETE FROM sessions WHERE expires_at <= now()");
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_SECONDS * 1000,
  });
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
