import dotenv from "dotenv";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const uploadsDir = path.join(rootDir, "uploads");
dotenv.config({ path: path.join(rootDir, ".env"), quiet: true });
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});
pool.on("error", (error) =>
  console.error("Database pool error:", error.message),
);

export type Role = "administrator" | "editor" | "author" | "subscriber";
export interface User {
  id: number;
  username: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: Date;
}
export const userFields = `id, username, email, display_name AS "displayName", role, created_at AS "createdAt"`;
export const postFields = `p.id, p.type, p.title, p.slug, p.content, p.excerpt, p.status,
  p.author_id AS "authorId", u.display_name AS "authorName", p.created_at AS "createdAt",
  p.updated_at AS "updatedAt", p.published_at AS "publishedAt"`;
export const mediaFields = `id, title, '/uploads/' || filename AS url, mime_type AS "mimeType", filename,
  alt, caption, size, created_at AS "createdAt"`;
export const commentFields = `c.id, c.author_name AS "authorName", c.author_email AS "authorEmail",
  c.content, c.status, c.post_id AS "postId", p.title AS "postTitle", c.created_at AS "createdAt"`;

export const defaultSettings = {
  siteTitle: "WorldAct",
  tagline: "Just another WorldAct site",
  siteUrl: process.env.APP_ORIGIN || "http://127.0.0.1:5173",
  adminEmail: process.env.ADMIN_EMAIL || "admin@worldact.local",
  timezone: "America/Los_Angeles",
  dateFormat: "F j, Y",
  timeFormat: "g:i a",
  postsPerPage: 10,
  discourageSearchEngines: false,
  theme: "twentytwentyfive" as const,
};
export async function getSettings() {
  const result = await pool.query<{ data: Partial<typeof defaultSettings> }>(
    "SELECT data FROM settings WHERE id = 1",
  );
  return { ...defaultSettings, ...result.rows[0]?.data };
}

export async function getPost(id: number) {
  const result = await pool.query(
    `SELECT ${postFields} FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = $1`,
    [id],
  );
  return result.rows[0];
}
export async function getComment(id: number) {
  const result = await pool.query(
    `SELECT ${commentFields} FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = $1`,
    [id],
  );
  return result.rows[0];
}
