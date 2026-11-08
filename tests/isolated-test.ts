import path from "node:path";

/** A mistake in a test command must fail before fixtures can reach a site. */
export function assertIsolatedTestContext(env: NodeJS.ProcessEnv = process.env): void {
  const reject = () => { throw new Error("Database/API tests require the disposable runner. Use npm test or npm run test:isolated -- tests/example.test.ts."); };
  if (env.WORLDACT_ISOLATED_TEST !== "1" || env.WORLDACT_MAIL_MODE !== "outbox") reject();
  let database: URL, api: URL;
  try { database = new URL(env.DATABASE_URL || ""); api = new URL(env.TEST_API_URL || ""); } catch { return reject(); }
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(database.hostname) || !/^\/worldact_test_\d+_[a-f0-9]{8}$/.test(database.pathname)) reject();
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || api.href !== new URL(`http://127.0.0.1:${port}/`).href) reject();
  if (!env.WORLDACT_UPLOADS_DIR || !path.isAbsolute(env.WORLDACT_UPLOADS_DIR) || !/^worldact-test-uploads-[a-z0-9]+$/i.test(path.basename(env.WORLDACT_UPLOADS_DIR))) reject();
}

assertIsolatedTestContext();
export { default, test, after, before, afterEach, beforeEach, describe, it, mock } from "node:test";
