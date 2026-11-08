import { createHash } from "node:crypto";

/** Explicit identity for unrelated raw SQL fixtures; independent of allocation. */
export function fixtureUserNicename(username: string): string {
  return "test-" + createHash("sha256").update(username).digest("hex").slice(0, 40);
}
