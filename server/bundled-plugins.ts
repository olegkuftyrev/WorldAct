import { Router } from "express";
import { isIP } from "node:net";
import { randomInt } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { pool, getSettings } from "./db.js";
import { requireRole, assertActiveAccountAuthentication, type AuthRequest } from "./auth.js";
import { HttpError, needUser, parseId } from "./utils.js";
import { postPermalink } from "./permalinks.js";
import lyrics from "../src/plugins/hello-dolly.json";

type Database = Pick<pg.Pool, "query"> | pg.PoolClient;
export const akismetKey = z
  .string()
  .trim()
  .max(128)
  .regex(/^(?:[A-Za-z0-9]{8,128})?$/);
export const bundledPluginRegistry = [
  {
    slug: "hello-dolly",
    name: "Hello Dolly",
    version: "1.7.2",
    description:
      "When activated, a random line from Hello, Dolly! appears in the upper right of your admin screen.",
    author: "Matt Mullenweg",
    settings: {},
  },
  {
    slug: "akismet",
    name: "Akismet Anti-spam: Spam Protection",
    version: "5.7.2",
    description:
      "Check comments for spam with Akismet. Activate the plugin, configure your API key, and enable comment processing to get started.",
    author: "Automattic – Anti-spam Team",
    settings: { sendComments: false },
  },
] as const;
export function helloDollyLyric(index = randomInt(lyrics.length)) {
  return lyrics[index % lyrics.length];
}
export type AkismetResult = "spam" | "ham" | "unavailable";
export type AkismetTransport = typeof fetch;
const host = "https://rest.akismet.com/1.1/";
export function safeServiceURL(value: string) {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    return url.href;
  } catch {
    return "";
  }
}
async function boundedText(response: Response) {
  if (!response.ok || !response.body) throw new Error("unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > 8192) throw new Error("unavailable");
      chunks.push(item.value);
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function createAkismetClient(transport: AkismetTransport = fetch) {
  async function request(
    method: "verify-key" | "comment-check" | "submit-spam" | "submit-ham",
    fields: Record<string, string>,
  ) {
    try {
      return await boundedText(
        await transport(host + method, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(3500),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "WorldAct/0.4.0 | Akismet/5.7.2",
          },
          body: new URLSearchParams(fields),
        }),
      );
    } catch {
      return null;
    }
  }
  return {
    async verify(
      apiKey: string,
      blog: string,
    ): Promise<"valid" | "invalid" | "unavailable"> {
      const text = await request("verify-key", { api_key: apiKey, blog });
      return text === "valid"
        ? "valid"
        : text === "invalid"
          ? "invalid"
          : "unavailable";
    },
    async check(fields: Record<string, string>): Promise<AkismetResult> {
      const text = await request("comment-check", fields);
      return text === "true"
        ? "spam"
        : text === "false"
          ? "ham"
          : "unavailable";
    },
    async report(type: "spam" | "ham", fields: Record<string, string>) {
      return (
        (await request(
          type === "spam" ? "submit-spam" : "submit-ham",
          fields,
        )) === "Thanks for making the web a better place."
      );
    },
  };
}
export async function readAkismetSecretStatus(database: Database = pool) {
  const settings = await getSettings(database);
  const row = (
    await database.query(
      "SELECT length(api_key)>0 AS configured,right(api_key,4) AS hint,verified_at,verified_site_url,last_error_code FROM extension_secrets WHERE slug='akismet'",
    )
  ).rows[0];
  return {
    apiKeyConfigured: Boolean(row?.configured),
    ...(row?.configured ? { apiKeyHint: "••••" + row.hint } : {}),
    keyVerified: Boolean(
      row?.verified_at &&
      row.verified_site_url === safeServiceURL(settings.siteUrl),
    ),
    verifiedAt: row?.verified_at || null,
    lastServiceError: row?.last_error_code || null,
  };
}
export async function setAkismetCredentials(
  database: Database,
  input: { apiKey?: string; clearApiKey?: boolean },
) {
  const key =
    input.apiKey === undefined ? undefined : akismetKey.parse(input.apiKey);
  if (input.clearApiKey && key)
    throw new HttpError(
      400,
      "Choose a new key or clear the existing key, not both.",
    );
  if (input.clearApiKey) {
    await database.query("DELETE FROM extension_secrets WHERE slug='akismet'");
    return;
  }
  if (!key) return;
  await database.query(
    "INSERT INTO extension_secrets(slug,api_key) VALUES('akismet',$1) ON CONFLICT(slug) DO UPDATE SET api_key=excluded.api_key,verified_at=CASE WHEN extension_secrets.api_key=excluded.api_key THEN extension_secrets.verified_at ELSE NULL END,verified_site_url=CASE WHEN extension_secrets.api_key=excluded.api_key THEN extension_secrets.verified_site_url ELSE NULL END,last_error_code=NULL,updated_at=now()",
    [key],
  );
}
async function akismetConfiguration(database: Database) {
  return (
    await database.query(
      "SELECT e.enabled,e.settings,s.api_key,s.verified_at,s.verified_site_url,s.updated_at::text AS credential_version FROM extensions e LEFT JOIN extension_secrets s ON s.slug=e.slug WHERE e.slug='akismet'",
    )
  ).rows[0];
}
/** Lock order is actor, plugin, secret. No caller keeps this client over HTTP. */
async function withAkismetAdministrator<T>(
  req: AuthRequest,
  work: (database: pg.PoolClient, config: any) => Promise<T>,
) {
  const database = await pool.connect();
  try {
    await database.query("BEGIN");
    const actor = (await database.query("SELECT role FROM users WHERE id=$1 FOR UPDATE", [needUser(req).id])).rows[0];
    if (!actor || actor.role !== "administrator") throw new HttpError(403, "Only administrators can configure connectors.");
    await assertActiveAccountAuthentication(req, database);
    const plugin = (await database.query("SELECT slug FROM extensions WHERE slug='akismet' FOR UPDATE")).rows[0];
    if (!plugin) throw new HttpError(404, "Install Akismet first.");
    await database.query("SELECT slug FROM extension_secrets WHERE slug='akismet' FOR UPDATE");
    const result = await work(database, await akismetConfiguration(database));
    await database.query("COMMIT");
    return result;
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  } finally {
    database.release();
  }
}
export async function updateAkismetConfiguration(
  req: AuthRequest,
  input: { enabled?: boolean; settings?: { sendComments?: boolean }; apiKey?: string; clearApiKey?: boolean },
  requireActive = false,
) {
  return withAkismetAdministrator(req, async (database, config) => {
    if (requireActive && !config.enabled) throw new HttpError(409, "Activate Akismet before connecting it.");
    const plugin = (await database.query(
      "UPDATE extensions SET enabled=coalesce($1,enabled),settings=jsonb_build_object('sendComments',coalesce($2,(settings->>'sendComments')::boolean,false)) WHERE slug='akismet' RETURNING slug,enabled,settings",
      [input.enabled ?? null, input.settings?.sendComments ?? null],
    )).rows[0];
    await setAkismetCredentials(database, input);
    return { ...plugin, ...(await readAkismetSecretStatus(database)) };
  });
}
export async function verifyAkismetKey(
  req: AuthRequest,
  service = createAkismetClient(),
) {
  const snapshot = await withAkismetAdministrator(req, async (database, config) => {
    if (!config.enabled || !config.settings?.sendComments || !config.api_key)
      throw new HttpError(409, "Activate Akismet, save an API key, and enable comment processing before verifying the key.");
    return { key: config.api_key, version: config.credential_version, site: safeServiceURL((await getSettings(database)).siteUrl) };
  });
  const result = await service.verify(snapshot.key, snapshot.site);
  return withAkismetAdministrator(req, async (database, config) => {
    const site = safeServiceURL((await getSettings(database)).siteUrl);
    if (!config.enabled || !config.settings?.sendComments || config.api_key !== snapshot.key ||
      !config.credential_version || config.credential_version !== snapshot.version || site !== snapshot.site)
      throw new HttpError(409, "The connector changed while verification was running. Review its current settings and try again.");
    await database.query(
      "UPDATE extension_secrets SET verified_at=CASE WHEN $1='valid' THEN now() ELSE NULL END,verified_site_url=CASE WHEN $1='valid' THEN $2 ELSE NULL END,last_error_code=CASE WHEN $1='valid' THEN NULL ELSE $1 END,updated_at=now() WHERE slug='akismet'",
      [result, site],
    );
    return { result, ...(await readAkismetSecretStatus(database)) };
  });
}
export interface AkismetComment {
  type?: "comment"|"pingback"|"trackback";
  userIP: string;
  userAgent: string;
  referrer: string;
  authorName: string;
  authorEmail: string;
  authorURL: string;
  content: string;
  permalink: string;
  userRole?: string;
  createdAt?: string;
}
export function akismetFields(
  input: AkismetComment,
  apiKey: string,
  blog: string,
) {
  return {
    api_key: apiKey,
    blog,
    user_ip: input.userIP,
    user_agent: input.userAgent.slice(0, 1024),
    referrer: safeServiceURL(input.referrer),
    comment_type: input.type || "comment",
    comment_author: input.authorName.slice(0, 160),
    comment_author_email: input.authorEmail.slice(0, 254),
    comment_author_url: safeServiceURL(input.authorURL),
    comment_content: input.content.slice(0, 20000),
    permalink: safeServiceURL(input.permalink),
    blog_charset: "UTF-8",
    ...(input.userRole ? { user_role: input.userRole } : {}),
    ...(input.createdAt ? { comment_date_gmt: input.createdAt } : {}),
  };
}
export async function checkAkismetComment(
  input: AkismetComment,
  database: Database = pool,
  client = createAkismetClient(),
): Promise<AkismetResult | "skipped"> {
  const config = await akismetConfiguration(database);
  if (!config?.enabled || !config.settings?.sendComments || !config.api_key)
    return "skipped";
  const site = safeServiceURL((await getSettings(database)).siteUrl);
  if (
    !config.verified_at ||
    config.verified_site_url !== site ||
    !isIP(input.userIP)
  )
    return "unavailable";
  const result = await client.check(akismetFields(input, config.api_key, site));
  await database.query(
    "UPDATE extension_secrets SET last_error_code=$1 WHERE slug='akismet'",
    [result === "unavailable" ? "unavailable" : null],
  );
  return result;
}
export async function recordAkismetCheck(
  commentId: number,
  input: AkismetComment,
  result: AkismetResult | "skipped",
  database: Database = pool,
) {
  if (result === "skipped") return;
  await database.query(
    "DELETE FROM akismet_comment_checks WHERE expires_at<=now()",
  );
  await database.query(
    "INSERT INTO akismet_comment_checks(comment_id,user_ip,user_agent,referrer,verdict) VALUES($1,$2,$3,$4,$5) ON CONFLICT(comment_id) DO UPDATE SET user_ip=excluded.user_ip,user_agent=excluded.user_agent,referrer=excluded.referrer,verdict=excluded.verdict,checked_at=now(),expires_at=now()+interval '30 days'",
    [
      commentId,
      input.userIP.slice(0, 64),
      input.userAgent.slice(0, 1024),
      safeServiceURL(input.referrer).slice(0, 2000),
      result,
    ],
  );
}
export async function reportAkismetTransition(
  commentId: number,
  previousStatus: string,
  nextStatus: string,
  database: Database = pool,
  client = createAkismetClient(),
) {
  const feedback =
    nextStatus === "spam" && previousStatus !== "spam"
      ? "spam"
      : previousStatus === "spam" &&
          ["approved", "pending"].includes(nextStatus)
        ? "ham"
        : null;
  if (!feedback) return "skipped";
  const config = await akismetConfiguration(database),
    settings = await getSettings(database),
    site = safeServiceURL(settings.siteUrl);
  if (
    !config?.enabled ||
    !config.settings?.sendComments ||
    !config.api_key ||
    !config.verified_at ||
    config.verified_site_url !== site
  )
    return "skipped";
  const row = (
    await database.query(
      "SELECT c.*,c.type AS comment_type,m.user_ip,m.user_agent,m.referrer,p.type,p.slug,p.parent_id AS post_parent_id,p.published_at FROM comments c JOIN akismet_comment_checks m ON m.comment_id=c.id AND m.expires_at>now() JOIN posts p ON p.id=c.post_id WHERE c.id=$1",
      [commentId],
    )
  ).rows[0];
  if (!row || !isIP(row.user_ip)) return "skipped";
  const permalink = new URL(
    await postPermalink(
      { ...row, id: row.post_id, parent_id: row.post_parent_id },
      settings,
      database,
    ),
    settings.siteUrl,
  ).href;
  const sent = await client.report(
    feedback,
    akismetFields(
      {
        type: row.comment_type,
        userIP: row.user_ip,
        userAgent: row.user_agent,
        referrer: row.referrer,
        authorName: row.author_name,
        authorEmail: row.author_email,
        authorURL: row.author_url,
        content: row.content,
        permalink,
        createdAt: new Date(row.created_at).toISOString(),
      },
      config.api_key,
      site,
    ),
  );
  await database.query(
    "UPDATE akismet_comment_checks SET feedback=$2,feedback_status=$3 WHERE comment_id=$1",
    [commentId, feedback, sent ? "sent" : "unavailable"],
  );
  await database.query(
    "UPDATE extension_secrets SET last_error_code=$1 WHERE slug='akismet'",
    [sent ? null : "unavailable"],
  );
  return sent ? "sent" : "unavailable";
}
export const bundledPluginsRouter = Router();
bundledPluginsRouter.get("/admin/plugin-notices", async (req, res) => {
  needUser(req);
  const active = (
    await pool.query(
      "SELECT 1 FROM extensions WHERE slug='hello-dolly' AND enabled=true",
    )
  ).rowCount;
  res.json({
    helloDolly: active
      ? {
          lyric: helloDollyLyric(),
          attribution: "Quote from Hello Dolly song, by Jerry Herman:",
        }
      : null,
  });
});
bundledPluginsRouter.post(
  "/plugins/akismet/verify",
  requireRole("administrator"),
  async (req, res) => {
    z.object({}).strict().parse(req.body || {});
    res.json(await verifyAkismetKey(req));
  },
);
bundledPluginsRouter.post(
  "/plugins/akismet/comments/:id/check",
  requireRole("administrator", "editor"),
  async (req, res) => {
    const commentId = parseId(req.params.id),
      row = (
        await pool.query(
          "SELECT c.*,c.type AS comment_type,p.slug,p.type,p.parent_id AS post_parent_id,p.published_at FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=$1",
          [commentId],
        )
      ).rows[0],
      meta = (
        await pool.query(
          "SELECT * FROM akismet_comment_checks WHERE comment_id=$1 AND expires_at>now()",
          [commentId],
        )
      ).rows[0];
    if (!row) throw new HttpError(404, "Comment not found.");
    if (!meta)
      throw new HttpError(
        409,
        "Original submission metadata is unavailable for this comment.",
      );
    const settings = await getSettings();
    const input: AkismetComment = {
      type: row.comment_type,
      userIP: meta.user_ip,
      userAgent: meta.user_agent,
      referrer: meta.referrer,
      authorName: row.author_name,
      authorEmail: row.author_email,
      authorURL: row.author_url,
      content: row.content,
      createdAt: new Date(row.created_at).toISOString(),
      permalink: new URL(
        await postPermalink(
          { ...row, id: row.post_id, parent_id: row.post_parent_id },
          settings,
          pool,
        ),
        settings.siteUrl,
      ).href,
    };
    const result = await checkAkismetComment(input);
    await recordAkismetCheck(commentId, input, result);
    res.json({ result });
  },
);
export default bundledPluginsRouter;
