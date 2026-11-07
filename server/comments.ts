import express from "express";
import { z } from "zod";
import { pool, commentFields, getComment } from "./db.js";
import { requireRole, type AuthRequest } from "./auth.js";
import {
  cleanContent,
  plainText,
  HttpError,
  parseId,
  needUser,
} from "./utils.js";
import type { PoolClient } from "pg";

const router = express.Router();
router.use("/comments", requireRole("administrator", "editor"));
const id = z.number().int().positive().max(2_147_483_647);
const status = z.enum(["approved", "pending", "spam", "trash"]);
const website = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => !value || /^https?:\/\//i.test(value),
    "Use an HTTP or HTTPS website URL.",
  );
const fields = z.object({
  authorName: z.string().trim().min(1).max(160),
  authorEmail: z.union([z.email().max(254), z.literal("")]),
  authorUrl: website,
  content: z.string().trim().min(1).max(20_000),
  status,
  parentId: id.nullable(),
});

router.get("/comments", async (req, res) => {
  const input = z
    .object({
      status: z
        .enum(["all", "approved", "pending", "spam", "trash"])
        .default("all"),
      excludeTrashSpam: z.enum(["true", "false"]).default("false"),
      search: z.string().trim().max(300).optional(),
      postId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
      page: z.coerce.number().int().positive().max(1_000_000).default(1),
      perPage: z.coerce.number().int().positive().max(1000).default(1000),
      order: z.enum(["asc", "desc"]).default("desc"),
      orderby: z.enum(["date", "author", "post"]).default("date"),
    })
    .strict()
    .parse(req.query);
  const params: unknown[] = [],
    where: string[] = [];
  const parameter = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (input.status !== "all") where.push(`c.status=${parameter(input.status)}`);
  else if (input.excludeTrashSpam === "true")
    where.push("c.status NOT IN ('trash','spam')");
  if (input.postId) where.push(`c.post_id=${parameter(input.postId)}`);
  if (input.search) {
    const term = parameter(`%${input.search.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(
      `(c.author_name ILIKE ${term} OR c.author_email ILIKE ${term} OR c.content ILIKE ${term} OR p.title ILIKE ${term})`,
    );
  }
  const predicate = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderBy = {
    date: "c.created_at",
    author: "c.author_name",
    post: "p.title",
  }[input.orderby];
  const [total, rows, counts] = await Promise.all([
    pool.query(
      `SELECT count(*)::int AS total FROM comments c JOIN posts p ON p.id=c.post_id ${predicate}`,
      params,
    ),
    pool.query(
      `SELECT ${commentFields} FROM comments c JOIN posts p ON p.id=c.post_id ${predicate} ORDER BY ${orderBy} ${input.order},c.id ${input.order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.perPage, (input.page - 1) * input.perPage],
    ),
    pool.query(
      `SELECT status,count(*)::int AS total FROM comments ${input.postId ? "WHERE post_id=$1" : ""} GROUP BY status`,
      input.postId ? [input.postId] : [],
    ),
  ]);
  res.json({
    comments: rows.rows,
    counts: Object.fromEntries(
      counts.rows.map((row) => [row.status, row.total]),
    ),
    pagination: {
      page: input.page,
      perPage: input.perPage,
      total: total.rows[0].total,
      totalPages: Math.max(1, Math.ceil(total.rows[0].total / input.perPage)),
    },
  });
});

async function validateParent(
  client: PoolClient,
  parentId: number | null,
  postId: number,
  childId?: number,
) {
  if (!parentId) return;
  let current: number | null = parentId;
  const seen = new Set<number>(childId ? [childId] : []);
  while (current) {
    if (seen.has(current) || seen.size >= 100)
      throw new HttpError(
        400,
        "Comment replies cannot form a cycle or exceed 100 levels.",
      );
    seen.add(current);
    const result: { rows: { post_id: number; parent_id: number | null }[] } =
      await client.query("SELECT post_id,parent_id FROM comments WHERE id=$1", [
        current,
      ]);
    const parent = result.rows[0];
    if (!parent || parent.post_id !== postId)
      throw new HttpError(400, "Choose a parent comment on the same post.");
    current = parent.parent_id;
  }
}
function cleanText(value: string, label: string) {
  const clean = plainText(value).trim();
  if (!clean) throw new HttpError(400, `Enter ${label} containing text.`);
  return clean;
}
function cleanBody(value: string) {
  const clean = cleanContent(value);
  if (!plainText(clean).trim())
    throw new HttpError(400, "Write a comment containing text.");
  return clean;
}

router.post("/comments", async (req: AuthRequest, res) => {
  const input = fields
    .partial()
    .extend({ postId: id, content: fields.shape.content })
    .strict()
    .parse(req.body);
  const user = needUser(req),
    client = await pool.connect();
  let resultId: number;
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))",
    );
    const post = await client.query(
      "SELECT id FROM posts WHERE id=$1 AND status<>'trash' FOR KEY SHARE",
      [input.postId],
    );
    if (!post.rowCount) throw new HttpError(404, "Post not found.");
    await validateParent(client, input.parentId ?? null, input.postId);
    const result = await client.query(
      "INSERT INTO comments(post_id,author_name,author_email,author_url,content,status,parent_id,user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [
        input.postId,
        cleanText(input.authorName ?? user.displayName, "a name"),
        (input.authorEmail ?? user.email).toLowerCase(),
        input.authorUrl ?? "",
        cleanBody(input.content),
        input.status ?? "approved",
        input.parentId ?? null,
        (input.authorEmail ?? user.email).toLowerCase() ===
        user.email.toLowerCase()
          ? user.id
          : null,
      ],
    );
    resultId = result.rows[0].id;
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.status(201).json({ comment: await getComment(resultId) });
});

router.put("/comments/:id", async (req, res) => {
  const commentId = parseId(req.params.id);
  const input = fields
    .partial()
    .extend({ version: z.number().int().positive().optional() })
    .strict()
    .refine(
      (value) => Object.keys(value).some((key) => key !== "version"),
      "Provide comment fields to update.",
    )
    .parse(req.body);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))",
    );
    const found = await client.query(
      "SELECT * FROM comments WHERE id=$1 FOR NO KEY UPDATE",
      [commentId],
    );
    const previous = found.rows[0];
    if (!previous) throw new HttpError(404, "Comment not found.");
    if (input.version !== undefined && input.version !== previous.version)
      throw new HttpError(
        409,
        "This comment changed in another window. Reload before saving.",
      );
    const parentId =
      input.parentId === undefined ? previous.parent_id : input.parentId;
    await validateParent(client, parentId, previous.post_id, commentId);
    let userId = previous.user_id;
    if (
      input.authorEmail !== undefined &&
      input.authorEmail.toLowerCase() !== previous.author_email.toLowerCase()
    ) {
      const account = userId
        ? (await client.query("SELECT email FROM users WHERE id=$1", [userId]))
            .rows[0]
        : null;
      if (
        !account ||
        account.email.toLowerCase() !== input.authorEmail.toLowerCase()
      )
        userId = null;
    }
    await client.query(
      "UPDATE comments SET author_name=$1,author_email=$2,author_url=$3,content=$4,status=$5,parent_id=$6,user_id=$8,version=version+1,updated_at=now() WHERE id=$7",
      [
        input.authorName === undefined
          ? previous.author_name
          : cleanText(input.authorName, "a name"),
        (input.authorEmail ?? previous.author_email).toLowerCase(),
        input.authorUrl ?? previous.author_url,
        input.content === undefined
          ? previous.content
          : cleanBody(input.content),
        input.status ?? previous.status,
        parentId,
        commentId,
        userId,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.json({ comment: await getComment(commentId) });
});

router.delete("/comments/:id", async (req, res) => {
  const id = parseId(req.params.id),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))",
    );
    const target = await client.query(
      "SELECT id FROM comments WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!target.rowCount) throw new HttpError(404, "Comment not found.");
    await client.query(
      "UPDATE comments SET parent_id=NULL,version=version+1,updated_at=now() WHERE parent_id=$1",
      [id],
    );
    const result = await client.query(
      "DELETE FROM comments WHERE id=$1 RETURNING id",
      [id],
    );
    if (!result.rowCount) throw new HttpError(404, "Comment not found.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true });
});
export default router;
