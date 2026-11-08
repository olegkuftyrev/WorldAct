import type { PoolClient } from "pg";

/** Acquire after all required user locks, before any existing post row lock.
 * Also serializes type conversions and multi-row scheduler/account mutations. */
export async function lockPageHierarchy(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-page-hierarchy'))");
}

/** Caller owns the hierarchy lock. Source wp_delete_post preserves children by
 * moving them to the deleted page's parent. Account deletion can remove several
 * ancestors at once, so skip the entire deletion set, not only one parent. */
export async function reparentDeletedPages(client: PoolClient, deletedIds: number[]) {
  if (!deletedIds.length) return;
  const ancestors = await client.query<{ id: number; parent_id: number | null }>(
    `WITH RECURSIVE ancestors AS (
      SELECT id,parent_id FROM posts WHERE type='page' AND id=ANY($1::int[])
      UNION
      SELECT p.id,p.parent_id FROM posts p JOIN ancestors a ON p.id=a.parent_id WHERE p.type='page'
    ) SELECT id,parent_id FROM ancestors`, [deletedIds],
  );
  if (!ancestors.rowCount) return;
  const children = await client.query<{ id: number; parent_id: number }>(
    "SELECT id,parent_id FROM posts WHERE type='page' AND parent_id=ANY($1::int[]) AND NOT(id=ANY($1::int[])) ORDER BY id", [deletedIds],
  );
  const parents = new Map(ancestors.rows.map(row => [row.id, row.parent_id])), deleted = new Set(deletedIds);
  const ids: number[] = [], destinations: Array<number | null> = [];
  for (const child of children.rows) {
    let cursor: number | null = child.parent_id, destination: number | null = null;
    const visited = new Set([child.id]);
    // UNION bounds the SQL closure; this walk also terminates corrupt historical
    // ancestry and never introduces a self/cyclic parent. Valid trees retain the
    // closest surviving ancestor, including through multiple deleted ancestors.
    while (cursor !== null) {
      if (visited.has(cursor) || !parents.has(cursor)) { destination = null; break; }
      visited.add(cursor);
      if (destination === null && !deleted.has(cursor)) destination = cursor;
      cursor = parents.get(cursor)!;
    }
    ids.push(child.id); destinations.push(destination);
  }
  if (ids.length) await client.query(
    `UPDATE posts p SET parent_id=m.parent_id,version=p.version+1
     FROM unnest($1::int[],$2::int[]) AS m(id,parent_id)
     WHERE p.id=m.id AND p.type='page' AND p.parent_id=ANY($3::int[])`,
    [ids, destinations, deletedIds],
  );
}
