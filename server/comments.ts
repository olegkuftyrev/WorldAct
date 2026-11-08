import {reportAkismetTransition} from "./bundled-plugins.js";
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
import {queueCommentNotifications} from "./core.js";
import {deliverMail} from "./accounts.js";
import { assertCommentAccess, canEditPostComments, canModerateAllComments, editableCommentPostsSQL } from "./comment-access.js";

const router = express.Router();
router.use("/comments", requireRole("administrator", "editor", "author", "contributor"));
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

router.get("/comments", async (req:AuthRequest, res) => {
  const user=needUser(req);
  const input = z
    .object({
      status: z
        .enum(["all", "approved", "pending", "spam", "trash"])
        .default("all"),
      excludeTrashSpam: z.enum(["true", "false"]).default("false"),
      search: z.string().trim().max(300).optional(),
      postId: z.coerce.number().int().positive().max(2_147_483_647).optional(),
      mine: z.enum(["true", "false"]).default("false"),
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
  const editable=editableCommentPostsSQL(user,parameter);
  where.push(`(${editable} OR (p.status='publish' AND p.password_hash IS NULL))`);
  if (input.postId) where.push(`c.post_id=${parameter(input.postId)}`);
  const countParams=params.slice(),countWhere=where.join(" AND ");
  if (input.mine === "true") where.push(`c.user_id=${parameter(user.id)}`);
  if (input.status !== "all") where.push(`c.status=${parameter(input.status)}`);
  else if (input.excludeTrashSpam === "true")
    where.push("c.status NOT IN ('trash','spam')");
  if (input.search) {
    const term = parameter(`%${input.search.replace(/[\\%_]/g, "\\$&")}%`);
    where.push(
      `(c.author_name ILIKE ${term} OR (${editable} AND c.author_email ILIKE ${term}) OR c.content ILIKE ${term} OR p.title ILIKE ${term})`,
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
      `SELECT ${commentFields},p.author_id AS "postAuthorId",p.type AS "postType",p.status AS "postStatus",p.pre_trash_status AS "postPreTrashStatus" FROM comments c JOIN posts p ON p.id=c.post_id ${predicate} ORDER BY ${orderBy} ${input.order},c.id ${input.order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, input.perPage, (input.page - 1) * input.perPage],
    ),
    pool.query(
      `SELECT c.status,count(*)::int AS total,count(*) FILTER(WHERE c.user_id=$${countParams.length+1} AND c.status NOT IN('trash','spam'))::int AS mine FROM comments c JOIN posts p ON p.id=c.post_id WHERE ${countWhere} GROUP BY c.status`,
      [...countParams,user.id],
    ),
  ]);
  res.json({
    comments: rows.rows.map(({postAuthorId,postType,postStatus,postPreTrashStatus,...comment})=>{
      const edit=canEditPostComments(user,{authorId:postAuthorId,type:postType,status:postStatus,preTrashStatus:postPreTrashStatus});
      if(!edit){delete comment.authorEmail;delete comment.userId;}
      return {...comment,permissions:{edit,reply:edit && !["spam","trash"].includes(comment.status),moderate:edit,delete:edit}};
    }),
    permissions:{bulk:canModerateAllComments(user),empty:canModerateAllComments(user)},
    counts: {...Object.fromEntries(
      counts.rows.map((row) => [row.status, row.total]),
    ),mine:counts.rows.reduce((total,row)=>total+row.mine,0)},
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
async function lockCommentPost(client:PoolClient,commentId:number,req:AuthRequest){
  // Lock the parent first, matching post deletion's lock order.
  const post=(await client.query('SELECT p.author_id AS "authorId",p.type,p.status,p.pre_trash_status AS "preTrashStatus" FROM posts p JOIN comments c ON c.post_id=p.id WHERE c.id=$1 FOR SHARE OF p',[commentId])).rows[0];
  if(!post)throw new HttpError(404,"Comment not found.");
  assertCommentAccess(needUser(req),post);
}

router.post("/comments/empty",requireRole("administrator","editor"),async(req,res)=>{
  const input=z.object({status:z.enum(["spam","trash"]),postId:id.optional()}).strict().parse(req.body);
  const db=await pool.connect();let deleted=0,hasMore=false;
  try{
    await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
    // Bound each request; the UI repeats batches while hasMore is true.
    const candidates=(await db.query("SELECT id,post_id FROM comments WHERE status=$1 AND ($2::int IS NULL OR post_id=$2) ORDER BY id LIMIT 500",[input.status,input.postId ?? null])).rows;
    if(candidates.length){
      await db.query("SELECT id FROM posts WHERE id=ANY($1::int[]) ORDER BY id FOR SHARE",[[...new Set(candidates.map(row=>row.post_id))]]);
      for(const candidate of candidates){
        const row=(await db.query("SELECT parent_id FROM comments WHERE id=$1 AND status=$2 FOR UPDATE",[candidate.id,input.status])).rows[0];
        if(!row)continue;
        await db.query("UPDATE comments SET parent_id=$2,version=version+1,updated_at=now() WHERE parent_id=$1",[candidate.id,row.parent_id]);
        deleted+=(await db.query("DELETE FROM comments WHERE id=$1",[candidate.id])).rowCount || 0;
      }
    }
    hasMore=Boolean((await db.query("SELECT 1 FROM comments WHERE status=$1 AND ($2::int IS NULL OR post_id=$2) LIMIT 1",[input.status,input.postId ?? null])).rowCount);
    await db.query("COMMIT");
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
  res.json({deleted,hasMore});
});

router.post("/comments", async (req: AuthRequest, res) => {
  const input = fields
    .partial()
    .extend({ postId: id, content: fields.shape.content })
    .strict()
    .parse(req.body);
  const user = needUser(req),
    client = await pool.connect();
  let resultId: number;
  let notifications:Awaited<ReturnType<typeof queueCommentNotifications>>=[];
  try {
    await client.query("BEGIN");
    if(!(await client.query("SELECT id FROM users WHERE id=$1 FOR KEY SHARE",[user.id])).rowCount)throw new HttpError(401,"This account is no longer available.");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))",
    );
    const post = await client.query(
      'SELECT id,author_id AS "authorId",type,status,pre_trash_status AS "preTrashStatus" FROM posts WHERE id=$1 AND status<>\'trash\' FOR SHARE',
      [input.postId],
    );
    if (!post.rowCount) throw new HttpError(404, "Post not found.");
    assertCommentAccess(user,post.rows[0]);
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
    notifications=await queueCommentNotifications(client,resultId,user.id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await Promise.all(notifications.map(deliverMail));
  res.status(201).json({ comment: await getComment(resultId) });
});

router.put("/comments/:id", async (req:AuthRequest, res) => {
  const commentId = parseId(req.params.id);
  const input = fields
    .partial()
    .extend({ version: z.number().int().positive().optional(), restore:z.literal(true).optional() })
    .strict()
    .refine(
      (value) => Object.keys(value).some((key) => key !== "version"),
      "Provide comment fields to update.",
    )
    .parse(req.body);
  const client = await pool.connect();
  let notifications:Awaited<ReturnType<typeof queueCommentNotifications>>=[];
  let previousStatus="";
  let nextStatus="";
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))",
    );
    await lockCommentPost(client,commentId,req);
    const found = await client.query(
      "SELECT * FROM comments WHERE id=$1 FOR NO KEY UPDATE",
      [commentId],
    );
    const previous = found.rows[0];
    previousStatus=previous?.status || "";
    if (!previous) throw new HttpError(404, "Comment not found.");
    if(input.restore && input.status)throw new HttpError(400,"Choose restore or a specific status.");
    if(input.restore && !["spam","trash"].includes(previous.status))throw new HttpError(400,"Only spam or trashed comments can be restored.");
    nextStatus=input.restore?(previous.previous_status || "pending"):(input.status ?? previous.status);
    const enteringRemoval=["spam","trash"].includes(nextStatus) && nextStatus!==previous.status;
    const priorStatus=input.restore?null:enteringRemoval?previous.status:nextStatus!==previous.status?null:previous.previous_status;
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
      "UPDATE comments SET author_name=$1,author_email=$2,author_url=$3,content=$4,status=$5::text,parent_id=$6,user_id=$8,previous_status=$9,trashed_at=CASE WHEN $5::text IN('spam','trash') THEN CASE WHEN status=$5::text THEN trashed_at ELSE now() END ELSE NULL END,version=version+1,updated_at=now() WHERE id=$7",
      [
        input.authorName === undefined
          ? previous.author_name
          : cleanText(input.authorName, "a name"),
        (input.authorEmail ?? previous.author_email).toLowerCase(),
        input.authorUrl ?? previous.author_url,
        input.content === undefined
          ? previous.content
          : cleanBody(input.content),
        nextStatus,
        parentId,
        commentId,
        userId,
        priorStatus,
      ],
    );
    if(nextStatus==="approved" && previous.status!=="approved")notifications=await queueCommentNotifications(client,commentId,needUser(req).id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await Promise.all(notifications.map(deliverMail));
  const akismetFeedback=await reportAkismetTransition(commentId,previousStatus,nextStatus).catch(()=>"unavailable");
  res.json({ comment: await getComment(commentId),akismetFeedback });
});

router.delete("/comments/:id", async (req:AuthRequest, res) => {
  const id = parseId(req.params.id),
    client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))",
    );
    await lockCommentPost(client,id,req);
    const target = await client.query(
      "SELECT id,post_id,parent_id FROM comments WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!target.rowCount) throw new HttpError(404, "Comment not found.");
    await client.query(
      "UPDATE comments SET parent_id=$2,version=version+1,updated_at=now() WHERE parent_id=$1",
      [id,target.rows[0].parent_id],
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
