import type { PoolClient } from "pg";

/** Shared once-only sample content for CLI and browser installation. */
export async function seedInitialContent(client: PoolClient, adminId: number) {
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
    if (post.rows[0]) {
      await client.query(
        "INSERT INTO post_terms(post_id,term_id) SELECT $1,id FROM terms WHERE is_default ON CONFLICT DO NOTHING",
        [post.rows[0].id],
      );
      await client.query(
        `INSERT INTO comments (post_id, author_name, author_email, content, status)
      VALUES ($1, 'A WorldAct Commenter', 'commenter@worldact.local', '<p>Hi, this is a comment. To get started with moderating, editing, and deleting comments, please visit the Comments screen in the dashboard.</p>', 'approved')`,
        [post.rows[0].id],
      );
    }
  }
}
