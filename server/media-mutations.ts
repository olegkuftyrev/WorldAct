import type { PoolClient } from "pg";
import { pool, type User } from "./db.js";
import { assertActiveAccountAuthentication, type AuthRequest } from "./auth.js";
import { needUser, HttpError } from "./utils.js";
import { lockPageHierarchy } from "./page-hierarchy.js";

/** Shared with core/account deletion: users -> hierarchy -> media/post rows.
 * Never acquire hierarchy while already owning an attachment row. */
export async function lockMediaMutation(client: PoolClient, req: AuthRequest) {
  const user = needUser(req);
  const actor = (await client.query<Pick<User, "id" | "role">>(
    "SELECT id,role FROM users WHERE id=$1 FOR SHARE", [user.id],
  )).rows[0];
  if (!actor) throw new HttpError(401, "Your account is unavailable. Sign in again.");
  await assertActiveAccountAuthentication(req, client);
  if (!["administrator", "editor", "author"].includes(actor.role))
    throw new HttpError(403, "You are not allowed to edit media.");
  if (actor.role !== user.role) throw new HttpError(409, "Your permissions changed. Reload before editing media.");
  await lockPageHierarchy(client);
  // A session can be revoked while hierarchy is held by a different writer.
  await assertActiveAccountAuthentication(req, client);
  return actor;
}

/** Pixel work may happen before this short final transaction. The callback must
 * re-read ownership and its filename token while holding the fresh media row. */
export async function mediaMutation<T>(req: AuthRequest, work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockMediaMutation(client, req);
    const result = await work(client);
    await assertActiveAccountAuthentication(req, client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}
