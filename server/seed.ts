import { pool, defaultSettings } from "./db.js";
import { hashPassword } from "./auth.js";
import { migrate } from "./migrate.js";
import { seedInitialContent } from "./initial-content.js";
import { allocateUserNicename, lockUserCreation } from "./user-nicenames.js";

export async function seed() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Set a valid ADMIN_EMAIL before seeding.");
  if (!password || password.length < 12)
    throw new Error(
      "Set ADMIN_PASSWORD to at least 12 characters before seeding.",
    );
  await migrate();
  const passwordHash = await hashPassword(password);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-seed'))",
    );
    await lockUserCreation(client);
    const existing = await client.query(
      "SELECT id FROM users WHERE role = $1 ORDER BY id LIMIT 1 FOR UPDATE",
      ["administrator"],
    );
    await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-account-identity'))");
    let adminId: number = existing.rows[0]?.id;
    if (!adminId) {
      const result = await client.query(
        `INSERT INTO users (username, email, display_name, password_hash, role,nicename)
        VALUES ('admin', $1, 'Administrator', $2, 'administrator',$3) RETURNING id`,
        [email, passwordHash,await allocateUserNicename(client,"admin")],
      );
      adminId = result.rows[0].id;
    }
    await client.query(
      "INSERT INTO settings (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
      [JSON.stringify(defaultSettings)],
    );
    await seedInitialContent(client, adminId);
    await client.query("COMMIT");
    console.log(
      "WorldAct seeded. Sign in with username admin or your administrator email.",
    );
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith("seed.ts")) {
  try {
    await seed();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
