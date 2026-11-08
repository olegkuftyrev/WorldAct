import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const browserInstall = process.argv.includes("--browser");
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
// Existing study configurations also get an explicit local network policy.
{
  const envPath=resolve(root,".env"),source=readFileSync(envPath,"utf8");
  if(!/^\s*(?:export\s+)?WORLDACT_ENVIRONMENT_TYPE\s*=/m.test(source))writeFileSync(envPath,source.replace(/\s*$/, "\n")+"WORLDACT_ENVIRONMENT_TYPE=local\n",{mode:0o600});
}
let installationToken;
if (browserInstall) {
  const envPath = resolve(root, ".env"), source = readFileSync(envPath, "utf8");
  installationToken = randomBytes(32).toString("hex");
  const line = "WORLDACT_INSTALL_TOKEN=" + installationToken;
  const updated = /^WORLDACT_INSTALL_TOKEN=.*$/m.test(source)
    ? source.replace(/^WORLDACT_INSTALL_TOKEN=.*$/m, line)
    : source.replace(/\s*$/, "\n") + line + "\n";
  writeFileSync(envPath, updated, { mode: 0o600 });
}
for (const [command, args] of [
  ["docker", ["compose", "up", "-d", "--wait", "db"]],
  ["npm", ["run", "db:migrate"]],
  ...(!browserInstall ? [["npm", ["run", "db:seed"]]] : []),
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
if (browserInstall) {
  const { default: dotenv } = await import("dotenv");
  const settings = dotenv.parse(readFileSync(resolve(root, ".env")));
  const url = new URL("/install", settings.APP_ORIGIN || "http://127.0.0.1:5173");
  url.hash = "token=" + installationToken;
  console.log("Database ready. Start npm run dev, then open this private installation link:");
  console.log(url.href);
} else console.log("WorldAct is ready. Start with npm run dev. Login details are in .env (ADMIN_EMAIL and ADMIN_PASSWORD).");
