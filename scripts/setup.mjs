import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(root, ".env"))) {
  const template = readFileSync(resolve(root, ".env.example"), "utf8");
  writeFileSync(
    resolve(root, ".env"),
    template.replace(
      "change-this-worldact-password",
      randomBytes(24).toString("base64url"),
    ),
    { mode: 0o600 },
  );
  console.log("Created local .env with a unique administrator password.");
}
chmodSync(resolve(root, ".env"), 0o600);
for (const [command, args] of [
  ["docker", ["compose", "up", "-d", "--wait", "db"]],
  ["npm", ["run", "db:migrate"]],
  ["npm", ["run", "db:seed"]],
]) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(
      result.error?.message ||
        `${command} failed. Fix the error above and run npm run setup again.`,
    );
    process.exit(result.status || 1);
  }
}
console.log(
  "WorldAct is ready. Start with npm run dev. Login details are in .env (ADMIN_EMAIL and ADMIN_PASSWORD).",
);
