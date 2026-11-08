import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createHash, randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool, getSettings, type Role } from "./db.js";
import { hashPassword, requireRole, type AuthRequest } from "./auth.js";
import { HttpError, parseId, needUser } from "./utils.js";
import { lockPageHierarchy } from "./page-hierarchy.js";
const router = Router(),
  admin = requireRole("administrator");
const CONFIRM_HOURS = 24,
  DOWNLOAD_DAYS = 3;
const ROLES = [
  "administrator",
  "editor",
  "author",
  "contributor",
  "subscriber",
] as const;
const tokenSchema = z.string().regex(/^[a-f0-9]{64}$/, "This link is invalid.");
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const appOrigin = () =>
  new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin;
const absolute = (path: string) => new URL(path, appOrigin()).href;
export const privacyRetention = {
  exported: [
    "Account profile fields",
    "Comments linked to the email address or account",
    "Retained Akismet submission IP, browser, referrer and classification metadata",
    "Unexpired comment flood-prevention IP addresses and expiry times",
  ],
  erased: [
    "Comment author names",
    "Comment author email addresses",
    "Comment author website URLs",
    "Comment links to registered user accounts",
    "Akismet submission and feedback metadata for matching comments",
    "Comment flood-prevention IP metadata for matching comments",
    "Existing personal-data export download links and files",
  ],
  retained: [
    "User accounts and profile fields",
    "Posts and pages",
    "Uploaded media",
    "Comment text and moderation status",
    "Privacy request audit records",
  ],
  message:
    "Erasure anonymizes matching comment authors, removes their Akismet submission and comment flood-prevention IP metadata and revokes existing personal-data exports. User accounts, profile fields, posts, pages, media, comment text, moderation status and privacy request records are retained. Delete an account separately in Users if required.",
};
const requestFields = `r.id,r.email,r.type,r.status,r.created_at AS "createdAt",r.updated_at AS "updatedAt",r.confirmed_at AS "confirmedAt",r.completed_at AS "completedAt",r.confirmation_expires_at AS "confirmationExpiresAt",r.download_expires_at AS "downloadExpiresAt",(r.export_data IS NOT NULL AND r.download_expires_at>now()) AS "hasExport",r.result,r.error,coalesce(u.display_name,'Deleted administrator') AS "requestedByName"`;
async function requestDto(
  id: number,
  client: Pick<PoolClient, "query"> = pool,
) {
  return (
    await client.query(
      `SELECT ${requestFields} FROM privacy_requests r LEFT JOIN users u ON u.id=r.requested_by WHERE r.id=$1`,
      [id],
    )
  ).rows[0];
}
async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
function rateLimit(max: number, windowMs: number) {
  const attempts = new Map<string, { count: number; expires: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "local",
      now = Date.now();
    if (attempts.size >= 10000)
      for (const [k, v] of attempts) if (v.expires <= now) attempts.delete(k);
    const previous = attempts.get(key);
    if (previous && previous.expires > now && previous.count >= max) {
      res.setHeader("Retry-After", Math.ceil((previous.expires - now) / 1000));
      next(new HttpError(429, "Too many attempts. Please try again later."));
      return;
    }
    if (attempts.size >= 10000 && !attempts.has(key)) {
      next(new HttpError(429, "Too many attempts. Please try again later."));
      return;
    }
    attempts.set(key, {
      count: previous && previous.expires > now ? previous.count + 1 : 1,
      expires:
        previous && previous.expires > now ? previous.expires : now + windowMs,
    });
    next();
  };
}
interface QueuedMail {
  id: number;
  recipient: string;
  subject: string;
  body: string;
}
export async function queueMail(
  client: PoolClient,
  recipient: string,
  subject: string,
  body: string,
): Promise<QueuedMail> {
  const row = await client.query(
    "INSERT INTO mail_outbox(recipient,subject,body) VALUES($1,$2,$3) RETURNING id",
    [recipient, subject, body],
  );
  return { id: row.rows[0].id, recipient, subject, body };
}
export async function deliverMail(mail: QueuedMail | null) {
  if (!mail) return null;
  if (
    !process.env.SMTP_HOST ||
    process.env.NODE_ENV === "test" ||
    process.env.WORLDACT_MAIL_MODE === "outbox"
  )
    return "local-outbox" as const;
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    connectionTimeout: 10000,
    socketTimeout: 10000,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || "WorldAct <worldact@localhost>",
      to: mail.recipient,
      subject: mail.subject,
      text: mail.body,
    });
    await pool.query("UPDATE mail_outbox SET delivered=true WHERE id=$1", [
      mail.id,
    ]);
  } catch {
    console.error(
      "Account email delivery failed; the message remains in the local mail outbox.",
    );
  } finally {
    transport.close();
  }
  return "queued" as const;
}
async function confirmationMail(
  client: PoolClient,
  id: number,
  email: string,
  type: string,
) {
  const token = randomBytes(32).toString("hex");
  await client.query(
    `UPDATE privacy_requests SET confirmation_token_hash=$1,confirmation_expires_at=now()+interval '24 hours',status='pending',confirmed_at=NULL,completed_at=NULL,error=NULL,result=NULL,export_data=NULL,download_token_hash=NULL,download_expires_at=NULL,updated_at=now() WHERE id=$2`,
    [hashToken(token), id],
  );
  const action = type === "export" ? "export" : "erase";
  return queueMail(
    client,
    email,
    `Confirm your WorldAct personal data ${action} request`,
    `A site administrator has requested to ${action} the personal data associated with this email address.\n\nReview and confirm this request within ${CONFIRM_HOURS} hours:\n${absolute("/privacy/confirm?token=" + token)}\n\nOpening the link does not confirm the request. You must choose Confirm on the page. Ignore this message if you did not authorize the request.\n\n${type === "erase" ? privacyRetention.message : ""}`,
  );
}
router.get("/auth/registration", async (_req, res) =>
  res.json({ enabled: (await getSettings()).usersCanRegister === true }),
);
router.post("/auth/register", rateLimit(20, 60 * 60_000), async (req, res) => {
  const input = z
    .object({
      username: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .regex(
          /^[a-zA-Z0-9_.@-]+$/,
          "Use letters, numbers, periods, underscores, @, or hyphens for the username.",
        ),
      email: z.email().max(254),
    })
    .strict()
    .parse(req.body);
  let mail: QueuedMail;
  try {
    mail = await transaction(async (client) => {
      const settings = await getSettings(client);
      if (!settings.usersCanRegister)
        throw new HttpError(403, "User registration is currently not allowed.");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-account-identity'))");
      if((await client.query("SELECT id FROM users WHERE lower(username)=ANY($1::text[]) OR lower(email)=ANY($1::text[])",[[input.username.toLowerCase(),input.email.toLowerCase()]])).rowCount)
        throw new HttpError(409,"That username or email address is already registered.");
      const role: Role = ROLES.includes(settings.defaultRole)
        ? settings.defaultRole
        : "subscriber";
      const passwordHash = await hashPassword(
        randomBytes(48).toString("base64url"),
      );
      const inserted = await client.query(
        "INSERT INTO users(username,email,display_name,password_hash,role) VALUES($1,$2,$1,$3,$4) RETURNING id",
        [input.username, input.email.toLowerCase(), passwordHash, role],
      );
      const token = randomBytes(32).toString("hex");
      await client.query(
        "INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 minutes')",
        [hashToken(token), inserted.rows[0].id],
      );
      return queueMail(
        client,
        input.email.toLowerCase(),
        "Set your WorldAct password",
        `Your WorldAct account has been created.\n\nUsername: ${input.username}\n\nSet your password within 30 minutes:\n${absolute("/reset-password?token=" + token)}\n\nA password is required before you can log in. If the link expires, request another one from the login page.`,
      );
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new HttpError(
        409,
        "That username or email address is already registered.",
      );
    throw error;
  }
  const delivery = await deliverMail(mail);
  res.status(201).json({
    ok: true,
    message:
      "Registration complete. Please check your email to set your password.",
    delivery,
  });
});
router.get("/tools/privacy/requests", admin, async (req, res) => {
  const input = z
    .object({
      type: z.enum(["export", "erase"]).optional(),
      status: z
        .enum(["all", "pending", "confirmed", "completed", "failed"])
        .default("all"),
      search: z.string().trim().max(254).default(""),
      page: z.coerce.number().int().positive().max(2147483647).default(1),
      perPage: z.coerce.number().int().min(1).max(100).default(20),
      orderby: z.enum(["createdAt", "email"]).default("createdAt"),
      order: z.enum(["asc", "desc"]).default("desc"),
    })
    .parse(req.query);
  // Export contents are temporary. Retain the audit request while removing expired data.
  await pool.query(
    "UPDATE privacy_requests SET export_data=NULL,download_token_hash=NULL WHERE download_expires_at<=now() AND export_data IS NOT NULL",
  );
  const args: unknown[] = [];
  let where = "true";
  if (input.type) {
    args.push(input.type);
    where += ` AND r.type=$${args.length}`;
  }
  if (input.search) {
    args.push("%" + input.search + "%");
    where += ` AND r.email ILIKE $${args.length}`;
  }
  const counts = (
    await pool.query(
      `SELECT count(*)::int AS all,count(*) FILTER(WHERE status='pending')::int AS pending,count(*) FILTER(WHERE status='confirmed')::int AS confirmed,count(*) FILTER(WHERE status='completed')::int AS completed,count(*) FILTER(WHERE status='failed')::int AS failed FROM privacy_requests r WHERE ${where}`,
      args,
    )
  ).rows[0];
  if (input.status !== "all") {
    args.push(input.status);
    where += ` AND r.status=$${args.length}`;
  }
  const total = (
    await pool.query(
      `SELECT count(*)::int AS total FROM privacy_requests r WHERE ${where}`,
      args,
    )
  ).rows[0].total;
  args.push(input.perPage, (input.page - 1) * input.perPage);
  const rows = (
    await pool.query(
      `SELECT ${requestFields} FROM privacy_requests r LEFT JOIN users u ON u.id=r.requested_by WHERE ${where} ORDER BY ${input.orderby === "email" ? "r.email" : "r.created_at"} ${input.order},r.id ${input.order} LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    )
  ).rows;
  res.json({
    requests: rows,
    counts,
    pagination: {
      page: input.page,
      perPage: input.perPage,
      totalRequests: total,
      totalPages: Math.max(1, Math.ceil(total / input.perPage)),
    },
    retention: privacyRetention,
  });
});
router.post("/tools/privacy/requests", admin, async (req: AuthRequest, res) => {
  const input = z
    .object({
      email: z.email().max(254),
      type: z.enum(["export", "erase"]),
      sendConfirmation: z.boolean().default(true),
    })
    .strict()
    .parse(req.body);
  let result: { request: any; mail: QueuedMail | null };
  try {
    result = await transaction(async (client) => {
      const inserted = await client.query(
        "INSERT INTO privacy_requests(email,type,status,requested_by,confirmed_at) VALUES($1,$2,$3,$4,CASE WHEN $3::varchar='confirmed' THEN now() ELSE NULL END) RETURNING id",
        [
          input.email.toLowerCase(),
          input.type,
          input.sendConfirmation ? "pending" : "confirmed",
          needUser(req).id,
        ],
      );
      const id = inserted.rows[0].id,
        mail = input.sendConfirmation
          ? await confirmationMail(
              client,
              id,
              input.email.toLowerCase(),
              input.type,
            )
          : null;
      return { request: await requestDto(id, client), mail };
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new HttpError(
        409,
        "An incomplete request of this type already exists for this email address.",
      );
    throw error;
  }
  const delivery = await deliverMail(result.mail);
  res.status(201).json({
    request: result.request,
    delivery,
    message: input.sendConfirmation
      ? "Confirmation request sent. The email owner must confirm before processing."
      : "The administrator has explicitly marked this request confirmed.",
  });
});
router.get("/tools/privacy/requests/:id", admin, async (req, res) => {
  const request = await requestDto(parseId(req.params.id));
  if (!request) throw new HttpError(404, "Privacy request not found.");
  res.json({ request, retention: privacyRetention });
});
router.put("/tools/privacy/requests/:id/confirm", admin, async (req, res) => {
  z.object({})
    .strict()
    .parse(req.body ?? {});
  const id = parseId(req.params.id);
  const request = await transaction(async (client) => {
    const row = (
      await client.query(
        "SELECT status FROM privacy_requests WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Privacy request not found.");
    if (row.status !== "completed")
      await client.query(
        "UPDATE privacy_requests SET status='confirmed',confirmed_at=coalesce(confirmed_at,now()),confirmation_token_hash=NULL,confirmation_expires_at=NULL,error=NULL,updated_at=now() WHERE id=$1",
        [id],
      );
    return requestDto(id, client);
  });
  res.json({
    request,
    message: "The administrator has explicitly marked this request confirmed.",
  });
});
router.post("/tools/privacy/requests/:id/resend", admin, async (req, res) => {
  z.object({})
    .strict()
    .parse(req.body ?? {});
  const id = parseId(req.params.id);
  const result = await transaction(async (client) => {
    const row = (
      await client.query(
        "SELECT email,type,status FROM privacy_requests WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Privacy request not found.");
    if (row.status === "completed")
      throw new HttpError(
        409,
        "This request is completed. Create a new request instead.",
      );
    const mail = await confirmationMail(client, id, row.email, row.type);
    return { request: await requestDto(id, client), mail };
  });
  res.json({
    request: result.request,
    delivery: await deliverMail(result.mail),
    message:
      "A new confirmation link was sent. Previous links are no longer valid.",
  });
});
router.delete("/tools/privacy/requests/:id", admin, async (req, res) => {
  const result = await pool.query(
    "DELETE FROM privacy_requests WHERE id=$1 RETURNING id",
    [parseId(req.params.id)],
  );
  if (!result.rowCount) throw new HttpError(404, "Privacy request not found.");
  res.json({ ok: true });
});
function maskedEmail(email: string) {
  const [local, domain] = email.split("@");
  return local.slice(0, 1) + "***@" + domain;
}
async function confirmationRequest(
  token: string,
  client: Pick<PoolClient, "query"> = pool,
  lock = false,
) {
  const row = (
    await client.query(
      `SELECT id,email,type,status,confirmation_expires_at FROM privacy_requests WHERE confirmation_token_hash=$1${lock ? " FOR UPDATE" : ""}`,
      [hashToken(token)],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(
      400,
      "This confirmation link is invalid or has been replaced.",
    );
  if (
    !row.confirmation_expires_at ||
    new Date(row.confirmation_expires_at).getTime() <= Date.now()
  )
    throw new HttpError(
      410,
      "This confirmation link has expired. Ask the site administrator to resend it.",
    );
  return row;
}
router.get("/privacy/confirm", rateLimit(60, 15 * 60_000), async (req, res) => {
  const token = tokenSchema.parse(req.query.token),
    row = await confirmationRequest(token);
  res.json({
    request: {
      type: row.type,
      status: row.status,
      emailMasked: maskedEmail(row.email),
      expiresAt: row.confirmation_expires_at,
    },
    message:
      row.status === "pending"
        ? "Confirm that you authorize this personal data request."
        : "This request has already been confirmed.",
    retention: row.type === "erase" ? privacyRetention : undefined,
  });
});
router.post(
  "/privacy/confirm",
  rateLimit(30, 15 * 60_000),
  async (req, res) => {
    const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
    const row = await transaction(async (client) => {
      const row = await confirmationRequest(token, client, true);
      if (row.status !== "pending")
        throw new HttpError(
          409,
          "This request has already been confirmed or completed.",
        );
      await client.query(
        "UPDATE privacy_requests SET status='confirmed',confirmed_at=now(),error=NULL,updated_at=now() WHERE id=$1",
        [row.id],
      );
      return row;
    });
    res.json({
      ok: true,
      request: {
        type: row.type,
        status: "confirmed",
        emailMasked: maskedEmail(row.email),
      },
      message:
        "Thank you. Your request is confirmed. The site administrator can now process it.",
    });
  },
);

// Serialize export and erasure for one identity so an export cannot capture
// pre-erasure rows and become downloadable after the erasure has committed.
async function lockedPrivacyAction(client: PoolClient, id: number) {
  const identity = (
    await client.query("SELECT email FROM privacy_requests WHERE id=$1", [id])
  ).rows[0];
  if (!identity) throw new HttpError(404, "Privacy request not found.");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('worldact-privacy-action:' || lower($1)))",
    [identity.email],
  );
  // An account may have comments under an older email address. Serialize those
  // aliases by stable user ID as well as email before locking individual requests.
  const linkedUsers = (
    await client.query(
      "SELECT id FROM users WHERE lower(email)=lower($1) UNION SELECT user_id AS id FROM comments WHERE lower(author_email)=lower($1) AND user_id IS NOT NULL ORDER BY id",
      [identity.email],
    )
  ).rows;
  for (const user of linkedUsers)
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-privacy-user:' || $1::text))",
      [user.id],
    );
  const row = (
    await client.query(
      "SELECT * FROM privacy_requests WHERE id=$1 FOR UPDATE",
      [id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Privacy request not found.");
  return row;
}
async function personalData(client: PoolClient, email: string) {
  const accounts = (
    await client.query(
      'SELECT id,username,email,display_name AS "displayName",created_at AS "createdAt",profile FROM users WHERE lower(email)=lower($1)',
      [email],
    )
  ).rows;
  const ids = accounts.map((user) => user.id);
  const size = (
    await client.query(
      "SELECT count(*)::int AS total,coalesce(sum(octet_length(c.content)+octet_length(c.author_name)+octet_length(c.author_email)+octet_length(c.author_url)+coalesce(octet_length(m.user_ip)+octet_length(m.user_agent)+octet_length(m.referrer),0)+coalesce(octet_length(f.author_ip)+128,0)),0)::bigint AS bytes FROM comments c LEFT JOIN akismet_comment_checks m ON m.comment_id=c.id AND m.expires_at>now() LEFT JOIN comment_flood_metadata f ON f.comment_id=c.id AND f.expires_at>clock_timestamp() WHERE lower(c.author_email)=lower($1) OR c.user_id=ANY($2::int[])",
      [email, ids],
    )
  ).rows[0];
  if (
    Number(size.bytes) + size.total * 512 + accounts.length * 10000 >
    16_000_000
  )
    throw new HttpError(
      413,
      "This personal data export exceeds the supported size.",
    );
  const comments = (
    await client.query(
      `SELECT id,post_id AS "postId",parent_id AS "parentId",author_name AS "authorName",author_email AS "authorEmail",author_url AS "authorUrl",content,type,status,created_at AS "createdAt" FROM comments WHERE lower(author_email)=lower($1) OR user_id=ANY($2::int[]) ORDER BY id`,
      [email, ids],
    )
  ).rows;
  const akismetChecks=(await client.query('SELECT m.comment_id AS "commentId",m.user_ip AS "userIP",m.user_agent AS "userAgent",m.referrer,m.verdict,m.checked_at AS "checkedAt",m.expires_at AS "expiresAt",m.feedback,m.feedback_status AS "feedbackStatus" FROM akismet_comment_checks m JOIN comments c ON c.id=m.comment_id WHERE (lower(c.author_email)=lower($1) OR c.user_id=ANY($2::int[])) AND m.expires_at>now() ORDER BY m.comment_id',[email,ids])).rows;
  const commentFloodMetadata=(await client.query('SELECT m.comment_id AS "commentId",m.author_ip AS "authorIP",m.expires_at AS "expiresAt" FROM comment_flood_metadata m JOIN comments c ON c.id=m.comment_id WHERE (lower(c.author_email)=lower($1) OR c.user_id=ANY($2::int[])) AND m.expires_at>clock_timestamp() ORDER BY m.comment_id',[email,ids])).rows;
  const safeAccounts = accounts.map(({ profile, ...user }) => ({
    ...user,
    profile: Object.fromEntries(
      ["firstName", "lastName", "nickname", "bio", "website"]
        .filter((key) => typeof profile?.[key] === "string")
        .map((key) => [key, profile[key]]),
    ),
  }));
  const settings = await getSettings(client);
  return {
    application: "WorldAct",
    siteTitle: settings.siteTitle,
    email,
    exportedAt: new Date().toISOString(),
    accounts: safeAccounts,
    comments,
    akismetChecks,
    commentFloodMetadata,
    scope: privacyRetention.exported,
  };
}
async function markFailed(id: number, type: string, error: unknown) {
  console.error(
    `Personal data ${type} failed:`,
    error instanceof Error ? error.message : "unknown error",
  );
  await pool
    .query(
      "UPDATE privacy_requests SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status<>'completed'",
      [
        id,
        `The personal data ${type} could not be completed. Check site health and retry.`,
      ],
    )
    .catch(() => {});
}
router.post("/tools/privacy/requests/:id/export", admin, async (req, res) => {
  z.object({})
    .strict()
    .parse(req.body ?? {});
  const id = parseId(req.params.id);
  let started = false;
  let result: {
    request: any;
    downloadUrl: string;
    expiresAt: Date | string;
    mail: QueuedMail | null;
  };
  try {
    result = await transaction(async (client) => {
      const row = await lockedPrivacyAction(client, id);
      if (!row) throw new HttpError(404, "Privacy request not found.");
      if (row.type !== "export")
        throw new HttpError(400, "This request is for erasure, not export.");
      if (row.status === "completed") {
        if (
          !row.export_data ||
          !row.download_expires_at ||
          new Date(row.download_expires_at).getTime() <= Date.now()
        )
          throw new HttpError(
            410,
            "This export has expired or was revoked. Create a new confirmed request.",
          );
        return {
          request: await requestDto(id, client),
          downloadUrl: absolute(
            "/api/tools/privacy/requests/" + id + "/download",
          ),
          expiresAt: row.download_expires_at,
          mail: null,
        };
      }
      if (!["confirmed", "failed"].includes(row.status) || !row.confirmed_at)
        throw new HttpError(
          409,
          "Confirm this request before exporting personal data.",
        );
      started = true;
      const data = await personalData(client, row.email);
      if (JSON.stringify(data).length > 16_000_000)
        throw new HttpError(413, "This export exceeds the supported size.");
      const token = randomBytes(32).toString("hex");
      const update = await client.query(
        "UPDATE privacy_requests SET status='completed',completed_at=now(),updated_at=now(),export_data=$2::jsonb,download_token_hash=$3,download_expires_at=now()+interval '3 days',error=NULL,result=$4::jsonb WHERE id=$1 RETURNING download_expires_at",
        [
          id,
          JSON.stringify(data),
          hashToken(token),
          JSON.stringify({
            accountsExported: data.accounts.length,
            commentsExported: data.comments.length,
            messages: [
              "A personal data export was generated. The download expires after three days.",
            ],
          }),
        ],
      );
      const downloadUrl = absolute("/api/privacy/download?token=" + token);
      const mail = await queueMail(
        client,
        row.email,
        "Your WorldAct personal data export is ready",
        `Your confirmed personal data export is ready.\n\nDownload it within ${DOWNLOAD_DAYS} days:\n${downloadUrl}\n\nAnyone with this private link can download the export. It expires automatically.`,
      );
      return {
        request: await requestDto(id, client),
        downloadUrl,
        expiresAt: update.rows[0].download_expires_at,
        mail,
      };
    });
  } catch (error) {
    if (started) await markFailed(id, "export", error);
    throw error;
  }
  const delivery = await deliverMail(result.mail);
  res.json({
    request: result.request,
    downloadUrl: result.downloadUrl,
    expiresAt: result.expiresAt,
    delivery,
  });
});
router.post("/tools/privacy/requests/:id/erase", admin, async (req, res) => {
  z.object({})
    .strict()
    .parse(req.body ?? {});
  const id = parseId(req.params.id);
  let started = false;
  let completed: { request: any; result: any; mail: QueuedMail | null };
  try {
    completed = await transaction(async (client) => {
      const row = await lockedPrivacyAction(client, id);
      if (!row) throw new HttpError(404, "Privacy request not found.");
      if (row.type !== "erase")
        throw new HttpError(400, "This request is for export, not erasure.");
      if (row.status === "completed")
        return {
          request: await requestDto(id, client),
          result: row.result,
          mail: null,
        };
      if (!["confirmed", "failed"].includes(row.status) || !row.confirmed_at)
        throw new HttpError(
          409,
          "Confirm this request before erasing personal data.",
        );
      started = true;
      // Post/account cascades acquire the page hierarchy before comment rows.
      // Serialize the entire multi-post cascade before taking comment hierarchy;
      // global comment-ID ordering alone cannot order cross-post FK cascades.
      await lockPageHierarchy(client);
      // Admission inserts comment + IP atomically under this same lock. Fence
      // erasure's metadata DELETE and later anonymization against a late commit.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('worldact-comment-hierarchy'))");
      const users = (
        await client.query(
          "SELECT id FROM users WHERE lower(email)=lower($1)",
          [row.email],
        )
      ).rows.map((user) => user.id);
      const removedAkismet=await client.query("DELETE FROM akismet_comment_checks m USING comments c WHERE m.comment_id=c.id AND (lower(c.author_email)=lower($1) OR c.user_id=ANY($2::int[])) RETURNING m.comment_id",[row.email,users]);
      const removedFlood=await client.query("DELETE FROM comment_flood_metadata m USING comments c WHERE m.comment_id=c.id AND (lower(c.author_email)=lower($1) OR c.user_id=ANY($2::int[])) RETURNING m.comment_id",[row.email,users]);
      const erased = await client.query(
        "UPDATE comments SET author_name='Anonymous',author_email='',author_url='',user_id=NULL,version=version+1,updated_at=now() WHERE lower(author_email)=lower($1) OR user_id=ANY($2::int[]) RETURNING id",
        [row.email, users],
      );
      const revoked = await client.query(
        `UPDATE privacy_requests r SET export_data=NULL,download_token_hash=NULL,updated_at=now() WHERE r.type='export' AND (r.export_data IS NOT NULL OR r.download_token_hash IS NOT NULL) AND (
          lower(r.email)=lower($1)
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.export_data->'accounts')='array' THEN r.export_data->'accounts' ELSE '[]'::jsonb END) account WHERE account->>'id'=ANY($2::text[]))
          OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.export_data->'comments')='array' THEN r.export_data->'comments' ELSE '[]'::jsonb END) comment WHERE comment->>'id'=ANY($3::text[]))
        ) RETURNING id`,
        [
          row.email,
          users.map(String),
          erased.rows.map((comment) => String(comment.id)),
        ],
      );
      const result = {
        commentsAnonymized: erased.rowCount || 0,
        akismetChecksRemoved:removedAkismet.rowCount || 0,
        commentFloodMetadataRemoved:removedFlood.rowCount || 0,
        exportsRevoked: revoked.rowCount || 0,
        messages: [
          "Matching comment author names, email addresses, website URLs and account links were anonymized. Akismet submission and comment flood-prevention IP metadata was removed. Existing personal-data exports were revoked.",
        ],
        retained: privacyRetention.retained,
      };
      await client.query(
        "UPDATE privacy_requests SET status='completed',completed_at=now(),updated_at=now(),error=NULL,result=$2::jsonb WHERE id=$1",
        [id, JSON.stringify(result)],
      );
      const mail = await queueMail(
        client,
        row.email,
        "Your WorldAct personal data erasure is complete",
        `Your confirmed personal data erasure request is complete.\n\n${privacyRetention.message}\n\nComment authors anonymized: ${result.commentsAnonymized}. Existing exports revoked: ${result.exportsRevoked}.`,
      );
      return { request: await requestDto(id, client), result, mail };
    });
  } catch (error) {
    if (started) await markFailed(id, "erasure", error);
    throw error;
  }
  res.json({
    request: completed.request,
    result: completed.result,
    delivery: await deliverMail(completed.mail),
  });
});
function download(res: Response, id: number, data: unknown) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="worldact-personal-data-${id}.json"`,
  );
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(JSON.stringify(data, null, 2));
}
router.get("/tools/privacy/requests/:id/download", admin, async (req, res) => {
  const id = parseId(req.params.id),
    row = (
      await pool.query(
        "SELECT type,status,export_data,download_expires_at FROM privacy_requests WHERE id=$1",
        [id],
      )
    ).rows[0];
  if (!row) throw new HttpError(404, "Privacy request not found.");
  if (row.type !== "export" || row.status !== "completed" || !row.export_data)
    throw new HttpError(404, "No export is available for this request.");
  if (
    !row.download_expires_at ||
    new Date(row.download_expires_at).getTime() <= Date.now()
  )
    throw new HttpError(410, "This personal data export has expired.");
  download(res, id, row.export_data);
});
router.get(
  "/privacy/download",
  rateLimit(120, 15 * 60_000),
  async (req, res) => {
    const token = tokenSchema.parse(req.query.token),
      row = (
        await pool.query(
          "SELECT id,export_data,download_expires_at FROM privacy_requests WHERE download_token_hash=$1 AND type='export' AND status='completed'",
          [hashToken(token)],
        )
      ).rows[0];
    if (!row || !row.export_data)
      throw new HttpError(
        404,
        "This personal data download is invalid or was revoked.",
      );
    if (
      !row.download_expires_at ||
      new Date(row.download_expires_at).getTime() <= Date.now()
    )
      throw new HttpError(410, "This personal data download has expired.");
    download(res, row.id, row.export_data);
  },
);
export default router;
