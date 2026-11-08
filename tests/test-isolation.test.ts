import test, { assertIsolatedTestContext } from "./isolated-test.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

test("test imports reject site databases, missing runner context and ordinary uploads", () => {
  assert.doesNotThrow(() => assertIsolatedTestContext());
  for (const change of [
    { WORLDACT_ISOLATED_TEST: undefined },
    { DATABASE_URL: "postgres://example:secret@127.0.0.1:54329/worldact" },
    { DATABASE_URL: "postgres://example:secret@remote.example.test/worldact_test_123_1234abcd" },
    { TEST_API_URL: "http://127.0.0.1:3001/api" },
    { WORLDACT_UPLOADS_DIR: "/tmp/uploads" },
    { WORLDACT_MAIL_MODE: "smtp" },
  ]) assert.throws(() => assertIsolatedTestContext({ ...process.env, ...change }), /disposable runner/);
});

test("direct test imports stop before the test body without exposing configuration", () => {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: "postgres://example:do-not-print@127.0.0.1:54329/worldact" };
  delete env.WORLDACT_ISOLATED_TEST;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'await import("./tests/isolated-test.ts"); process.stdout.write("REACHED_TEST_BODY");'], { env, encoding: "utf8", timeout: 10000 });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /disposable runner/);
  assert.doesNotMatch(child.stdout + child.stderr, /REACHED_TEST_BODY|do-not-print|postgres:\/\//);
});

test("every regression imports the isolation guard before other application modules", async () => {
  for (const file of (await readdir(new URL(".", import.meta.url))).filter(name => name.endsWith(".test.ts"))) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source.split("\n")[0], /^import .+ from ["']\.\/isolated-test\.js["'];?$/, file);
    assert.doesNotMatch(source, /from\s*["']node:test["']/, file);
  }
});
