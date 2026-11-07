import { pool, defaultSettings } from "./db.js";
import { hashPassword } from "./auth.js";
import { migrate } from "./migrate.js";

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
    const existing = await client.query(
      "SELECT id FROM users WHERE role = $1 ORDER BY id LIMIT 1",
      ["administrator"],
    );
    let adminId: number = existing.rows[0]?.id;
    if (!adminId) {
      const result = await client.query(
        `INSERT INTO users (username, email, display_name, password_hash, role)
        VALUES ('admin', $1, 'Administrator', $2, 'administrator') RETURNING id`,
        [email, passwordHash],
      );
      adminId = result.rows[0].id;
    }
    await client.query(
      "INSERT INTO settings (id, data) VALUES (1, $1) ON CONFLICT (id) DO NOTHING",
      [JSON.stringify(defaultSettings)],
    );
    const marker = await client.query(
      "INSERT INTO seed_markers (name) VALUES ('initial-content-v1') ON CONFLICT DO NOTHING RETURNING name",
    );
    if (marker.rowCount) {
      const post = await client.query(
        `INSERT INTO posts (type, title, slug, content, excerpt, status, author_id, published_at)
        VALUES ('post', 'Hello world!', 'hello-world', '<p>Welcome to WorldAct. This is your first post. Edit or delete it, then start writing!</p>', '', 'publish', $1, now())
        ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [adminId],
      );
      await client.query(
        `INSERT INTO posts (type, title, slug, content, excerpt, status, author_id, published_at)
        VALUES ('page', 'Sample Page', 'sample-page', '<p>This is an example page. You can edit this page from your WorldAct dashboard and create new pages for your site.</p>', '', 'publish', $1, now()) ON CONFLICT (slug) DO NOTHING`,
        [adminId],
      );
      if (post.rows[0])
        await client.query(
          `INSERT INTO comments (post_id, author_name, author_email, content, status)
        VALUES ($1, 'A WorldAct Commenter', 'commenter@worldact.local', '<p>Hi, this is a comment. To get started with moderating, editing, and deleting comments, please visit the Comments screen in the dashboard.</p>', 'approved')`,
          [post.rows[0].id],
        );
    }
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
