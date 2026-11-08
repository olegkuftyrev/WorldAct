import type { PoolClient } from "pg";
import { HttpError } from "./utils.js";

/** Source-default ASCII user_nicename rules. Truncation precedes sanitizing. */
export function defaultUserNicename(username: string): string {
  return username.slice(0, 50).toLowerCase().replace(/\./g, "-")
    .replace(/[^a-z0-9_-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
}
export function validUserNicename(value: unknown): value is string {
  return typeof value === "string" && value.length <= 50 && /^[a-z0-9_-]+$/.test(value) && value !== "0";
}
export function requireDefaultUserNicename(username: string): string {
  const value = defaultUserNicename(username);
  if (!validUserNicename(value)) throw new HttpError(400, "Choose a username that produces a valid public author name.");
  return value;
}
export function userNicenameCandidate(base: string, suffix: number): string {
  if (suffix === 1) return base;
  const digits = String(suffix);
  return base.slice(0, 49 - digits.length) + "-" + digits;
}
/** First operation after BEGIN for ordinary creators; seed/install first hold
 * their existing seed lock. Never acquire this barrier from profile mutations. */
export async function lockUserCreation(db: PoolClient) {
  await db.query("SELECT pg_advisory_xact_lock(hashtext('worldact-user-creation'))");
}
/** Caller owns creation barrier and account-identity for this transaction. */
export async function allocateUserNicename(db: PoolClient, username: string): Promise<string> {
  const base = requireDefaultUserNicename(username);
  const used = new Set((await db.query("SELECT nicename FROM users")).rows.map(row => row.nicename));
  for (let suffix = 1; ; suffix++) {
    const candidate = userNicenameCandidate(base, suffix);
    if (!used.has(candidate)) return candidate;
  }
}
