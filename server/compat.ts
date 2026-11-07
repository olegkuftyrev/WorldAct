import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { randomBytes } from "node:crypto";
import {
  pool,
  getPost,
  getSettings,
  postFields,
  mediaFields,
  type User,
} from "./db.js";
import {
  attachUser,
  requireRole,
  hashPassword,
  type AuthRequest,
} from "./auth.js";
import {
  HttpError,
  parseId,
  needUser,
  cleanContent,
  plainText,
  cleanRawContent,
  slugify,
} from "./utils.js";
import {
  postPermalink,
  resolvePublicPath,
  withPermalink,
} from "./permalinks.js";
import { z } from "zod";
const router = express.Router();
const admin = requireRole("administrator");
const esc = (value: unknown) =>
  String(value ?? "").replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const cdata = (value: unknown) =>
  "<![CDATA[" + String(value ?? "").replace(/]]>/g, "]]]]><![CDATA[>") + "]]>";
const absolute = (path: string, siteUrl: string) => new URL(path, siteUrl).href;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
const wpDate = (value: unknown) =>
  value
    ? iso(value)
        .replace("T", " ")
        .replace(/\.\d{3}Z$/, "")
    : "0000-00-00 00:00:00";
const list = (value: any) =>
  value === undefined || value === null
    ? []
    : Array.isArray(value)
      ? value
      : [value];
const text = (value: any) =>
  String(
    value && typeof value === "object" ? (value["#text"] ?? "") : (value ?? ""),
  );
const zero = (value: any) => Number(text(value)) || 0;
router.use(["/wp-json", "/api/tools/export", "/api/tools/import"], attachUser);
router.use("/wp-json", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const expected = new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173")
      .origin;
    if (req.headers.origin !== expected)
      return res.status(403).json({
        code: "rest_cookie_invalid_origin",
        message: "This request must come from the configured site origin.",
        data: { status: 403 },
      });
  }
  next();
});
async function forward(
  req: Request,
  path: string,
  method = "GET",
  body?: unknown,
  multipart = false,
) {
  const port = req.socket.localPort;
  if (!port) throw new HttpError(503, "The internal API is unavailable.");
  const headers: Record<string, string> = {
    Origin: new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin,
  };
  if (req.headers.cookie) headers.Cookie = req.headers.cookie;
  if (multipart)
    headers["Content-Type"] = String(
      req.headers["content-type"] || "application/octet-stream",
    );
  else headers["Content-Type"] = "application/json";
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers,
    body: multipart
      ? (req as any)
      : body === undefined
        ? undefined
        : JSON.stringify(body),
    ...(multipart ? { duplex: "half" as const } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new HttpError(
      response.status,
      data.error || data.message || "The operation could not be completed.",
    );
  return { data, status: response.status };
}
router.get("/api/public/resolve", async (req, res) => {
  const path = z
    .string()
    .min(1)
    .max(2000)
    .refine(
      (v) => v.startsWith("/") && !v.startsWith("//") && !v.includes("\0"),
      "Use a site-relative path.",
    )
    .parse(req.query.path);
  let resolved;
  try {
    resolved = await resolvePublicPath(path);
  } catch (error) {
    if (error instanceof URIError)
      throw new HttpError(400, "The URL path is malformed.");
    throw error;
  }
  if (!resolved) {
    const settings = await getSettings();
    const parts = path
      .split("?")[0]
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const taxonomy =
      parts[0] === settings.categoryBase
        ? "category"
        : parts[0] === settings.tagBase
          ? "tag"
          : null;
    if (taxonomy && parts.length === 2) {
      const term = (
        await pool.query(
          "SELECT id,taxonomy,slug,name FROM terms WHERE taxonomy=$1 AND slug=$2",
          [taxonomy, parts[1]],
        )
      ).rows[0];
      if (term) {
        res.json({ archive: term });
        return;
      }
    }
    throw new HttpError(404, "Post not found.");
  }
  const result = await forward(
    req,
    "/public/posts/" + encodeURIComponent(resolved.slug),
  );
  res.json(result.data);
});
async function feedPosts() {
  const settings = await getSettings();
  const posts = (
    await pool.query(
      `SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.type='post' AND p.status='publish' AND p.password_hash IS NULL ORDER BY p.published_at DESC,p.id DESC LIMIT $1`,
      [settings.feedItems],
    )
  ).rows;
  return {
    settings,
    posts: await Promise.all(posts.map((p) => withPermalink(p, settings))),
  };
}
router.get(
  ["/feed", "/feed/", "/feed/rss2", "/feed/rss2/", "/rss.xml"],
  async (_req, res) => {
    const { settings, posts } = await feedPosts();
    const feed = absolute("/feed/", settings.siteUrl);
    res
      .type("application/rss+xml")
      .send(
        `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${esc(settings.siteTitle)}</title><link>${esc(settings.siteUrl)}</link><description>${esc(settings.tagline)}</description><language>en-US</language><atom:link href="${esc(feed)}" rel="self" type="application/rss+xml"/>${posts.map((p) => `<item><title>${esc(p.title)}</title><link>${esc(absolute(p.permalink, settings.siteUrl))}</link><guid isPermaLink="false">worldact:${p.id}</guid><pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate><dc:creator>${cdata(p.authorName)}</dc:creator><description>${cdata(p.excerpt || plainText(p.content).slice(0, 400))}</description><content:encoded>${cdata(settings.feedExcerpt ? p.excerpt || "<p>" + esc(plainText(p.content).slice(0, 400)) + "</p>" : p.content)}</content:encoded>${p.terms.map((t: any) => `<category>${cdata(t.name)}</category>`).join("")}</item>`).join("")}</channel></rss>`,
      );
  },
);
router.get(["/feed/atom", "/feed/atom/", "/atom.xml"], async (_req, res) => {
  const { settings, posts } = await feedPosts();
  res
    .type("application/atom+xml")
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>${esc(settings.siteTitle)}</title><subtitle>${esc(settings.tagline)}</subtitle><id>${esc(settings.siteUrl)}</id><link href="${esc(absolute("/feed/atom/", settings.siteUrl))}" rel="self"/><link href="${esc(settings.siteUrl)}"/><updated>${posts[0] ? iso(posts[0].updatedAt) : new Date().toISOString()}</updated>${posts.map((p) => `<entry><title>${esc(p.title)}</title><id>urn:worldact:post:${p.id}</id><link href="${esc(absolute(p.permalink, settings.siteUrl))}"/><published>${iso(p.publishedAt)}</published><updated>${iso(p.updatedAt)}</updated><author><name>${esc(p.authorName)}</name></author><summary>${esc(p.excerpt || plainText(p.content).slice(0, 400))}</summary><content type="html">${esc(settings.feedExcerpt ? p.excerpt || plainText(p.content).slice(0, 400) : p.content)}</content></entry>`).join("")}</feed>`,
    );
});
router.get(["/comments/feed", "/comments/feed/"], async (_req, res) => {
  const settings = await getSettings();
  const comments = (
    await pool.query(
      `SELECT c.id,c.author_name,c.content,c.created_at,p.id AS post_id,p.type,p.slug,p.title,p.published_at,p.parent_id FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.status='approved' AND p.status='publish' AND p.password_hash IS NULL ORDER BY c.created_at DESC,c.id DESC LIMIT $1`,
      [settings.feedItems],
    )
  ).rows;
  const entries = await Promise.all(
    comments.map(
      async (c) =>
        `<item><title>${esc("Comment on " + c.title + " by " + c.author_name)}</title><link>${esc(absolute(await postPermalink({ ...c, id: c.post_id }, settings), settings.siteUrl) + "#comment-" + c.id)}</link><guid isPermaLink="false">worldact:comment:${c.id}</guid><pubDate>${new Date(c.created_at).toUTCString()}</pubDate><dc:creator>${cdata(c.author_name)}</dc:creator><description>${cdata(c.content)}</description></item>`,
    ),
  );
  res
    .type("application/rss+xml")
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>${esc("Comments for " + settings.siteTitle)}</title><link>${esc(settings.siteUrl)}</link><description>${esc(settings.tagline)}</description>${entries.join("")}</channel></rss>`,
    );
});
router.get(["/sitemap.xml", "/wp-sitemap.xml"], async (_req, res) => {
  const settings = await getSettings();
  if (settings.discourageSearchEngines) {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res
      .type("application/xml")
      .send(
        '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>',
      );
    return;
  }
  const posts = (
    await pool.query(
      `SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.status='publish' AND p.password_hash IS NULL ORDER BY p.id LIMIT 50000`,
    )
  ).rows;
  const urls = await Promise.all(
    posts.map(
      async (p) =>
        `<url><loc>${esc(absolute(await postPermalink(p, settings), settings.siteUrl))}</loc><lastmod>${iso(p.updatedAt)}</lastmod></url>`,
    ),
  );
  res
    .type("application/xml")
    .send(
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${esc(settings.siteUrl)}</loc></url>${urls.join("")}</urlset>`,
    );
});
router.get("/robots.txt", async (_req, res) => {
  const settings = await getSettings();
  res
    .type("text/plain")
    .send(
      settings.discourageSearchEngines
        ? "User-agent: *\nDisallow: /\n"
        : `User-agent: *\nDisallow: /admin/\nDisallow: /api/\nDisallow: /wp-admin/\nSitemap: ${absolute("/sitemap.xml", settings.siteUrl)}\n`,
    );
});

function pagination(req: Request, res: Response, total: number) {
  const page = z.coerce
      .number()
      .int()
      .positive()
      .max(2147483647)
      .default(1)
      .parse(req.query.page),
    perPage = z.coerce
      .number()
      .int()
      .positive()
      .max(100)
      .default(10)
      .parse(req.query.per_page);
  if (page > 1 && page > Math.ceil(total / perPage))
    throw new HttpError(
      400,
      "The page number requested is larger than the number of pages available.",
    );
  res.setHeader("X-WP-Total", total);
  res.setHeader("X-WP-TotalPages", Math.ceil(total / perPage));
  return { page, perPage, offset: (page - 1) * perPage };
}
function wpFields(req: Request, value: any) {
  const fields =
    typeof req.query._fields === "string"
      ? req.query._fields.split(",").map((s) => s.trim())
      : null;
  if (!fields) return value;
  const pick = (item: any) =>
    Object.fromEntries(
      fields
        .filter((f) => Object.prototype.hasOwnProperty.call(item, f))
        .map((f) => [f, item[f]]),
    );
  return Array.isArray(value) ? value.map(pick) : pick(value);
}
async function wpPost(post: any, req: AuthRequest, edit = false) {
  const settings = await getSettings(),
    link = absolute(await postPermalink(post, settings), settings.siteUrl);
  const protectedPost = !!post.hasPassword;
  const own = canEdit(req.user, post);
  const raw = edit && own ? post.rawContent || post.content : undefined;
  return {
    id: post.id,
    date: iso(post.publishedAt || post.createdAt).replace(/Z$/, ""),
    date_gmt: iso(post.publishedAt || post.createdAt).replace(/Z$/, ""),
    guid: { rendered: link },
    modified: iso(post.updatedAt).replace(/Z$/, ""),
    modified_gmt: iso(post.updatedAt).replace(/Z$/, ""),
    slug: post.slug,
    status: post.status,
    type: post.type,
    link,
    title: {
      rendered: esc(post.title),
      ...(raw !== undefined ? { raw: post.title } : {}),
    },
    content: {
      rendered: protectedPost && !own ? "" : post.content,
      protected: protectedPost,
      ...(raw !== undefined ? { raw } : {}),
    },
    excerpt: {
      rendered: protectedPost && !own ? "" : post.excerpt,
      protected: protectedPost,
      ...(raw !== undefined ? { raw: post.excerpt } : {}),
    },
    author: post.authorId,
    featured_media: post.featuredMediaId || 0,
    parent: post.parentId || 0,
    menu_order: post.menuOrder || 0,
    comment_status: post.commentStatus,
    ping_status: "closed",
    sticky: post.sticky,
    template: "",
    format: post.format || "standard",
    meta: {},
    categories:
      post.categoryIds ||
      post.terms
        ?.filter((t: any) => t.taxonomy === "category")
        .map((t: any) => t.id) ||
      [],
    tags:
      post.tagIds ||
      post.terms
        ?.filter((t: any) => t.taxonomy === "tag")
        .map((t: any) => t.id) ||
      [],
    _links: {
      self: [
        {
          href: absolute(
            `/wp-json/wp/v2/${post.type === "page" ? "pages" : "posts"}/${post.id}`,
            settings.siteUrl,
          ),
        },
      ],
      collection: [
        {
          href: absolute(
            `/wp-json/wp/v2/${post.type === "page" ? "pages" : "posts"}`,
            settings.siteUrl,
          ),
        },
      ],
    },
  };
}
function canEdit(user: User | undefined, post: any) {
  return (
    !!user &&
    ["administrator", "editor", "author", "contributor"].includes(user.role) &&
    (!["author", "contributor"].includes(user.role) ||
      (user.id === post.authorId &&
        post.type === "post" &&
        (user.role !== "contributor" ||
          ["draft", "pending", "trash"].includes(post.status))))
  );
}
router.get(["/wp-json", "/wp-json/"], async (_req, res) => {
  const s = await getSettings();
  res.json({
    name: s.siteTitle,
    description: s.tagline,
    url: s.siteUrl,
    home: s.siteUrl,
    namespaces: ["wp/v2"],
    authentication: {},
    routes: {
      "/wp/v2/posts": { namespace: "wp/v2", methods: ["GET", "POST"] },
      "/wp/v2/pages": { namespace: "wp/v2", methods: ["GET", "POST"] },
    },
  });
});

router.get(["/wp-json/wp/v2", "/wp-json/wp/v2/"], (_req, res) =>
  res.json({
    namespace: "wp/v2",
    routes: {
      "/wp/v2/posts": { methods: ["GET", "POST"] },
      "/wp/v2/pages": { methods: ["GET", "POST"] },
      "/wp/v2/media": { methods: ["GET", "POST"] },
      "/wp/v2/categories": { methods: ["GET", "POST"] },
      "/wp/v2/tags": { methods: ["GET", "POST"] },
      "/wp/v2/comments": { methods: ["GET", "POST"] },
    },
  }),
);
const integerList = (value: unknown) =>
  value === undefined
    ? []
    : z
        .string()
        .max(2000)
        .parse(value)
        .split(",")
        .map((value) => parseId(value.trim()));
for (const collection of ["posts", "pages"] as const) {
  const type = collection === "pages" ? "page" : "post";
  router.get("/wp-json/wp/v2/" + collection, async (req: AuthRequest, res) => {
    const edit = req.query.context === "edit",
      user = req.user;
    if (edit && !user)
      throw new HttpError(
        401,
        "Authentication is required for the edit context.",
      );
    const status = z
      .enum([
        "publish",
        "draft",
        "pending",
        "future",
        "private",
        "trash",
        "any",
      ])
      .default("publish")
      .parse(req.query.status);
    if (status !== "publish" && !user)
      throw new HttpError(
        401,
        "Authentication is required to read unpublished content.",
      );
    if (
      (edit || status !== "publish") &&
      (!user ||
        !["administrator", "editor", "author", "contributor"].includes(
          user.role,
        ))
    )
      throw new HttpError(403, "You cannot edit this content.");
    const args: unknown[] = [type];
    let where = "p.type=$1";
    if (status !== "any") {
      args.push(status);
      where += ` AND p.status=$${args.length}`;
    } else where += " AND p.status<>'trash'";
    if (
      (edit || status !== "publish") &&
      user &&
      ["author", "contributor"].includes(user.role)
    ) {
      if (type === "page") throw new HttpError(403, "You cannot edit pages.");
      args.push(user.id);
      where += ` AND p.author_id=$${args.length}`;
      if (user.role === "contributor")
        where += " AND p.status IN('draft','pending','trash')";
    }
    if (req.query.slug !== undefined) {
      args.push(z.string().max(2000).parse(req.query.slug).split(","));
      where += ` AND p.slug=ANY($${args.length}::text[])`;
    }
    if (req.query.search !== undefined) {
      args.push("%" + z.string().max(200).parse(req.query.search) + "%");
      where += ` AND (p.title ILIKE $${args.length} OR (p.password_hash IS NULL AND p.content ILIKE $${args.length}))`;
    }
    for (const [field, column] of [
      ["include", "p.id"],
      ["exclude", "p.id"],
      ["author", "p.author_id"],
    ] as const)
      if (req.query[field] !== undefined) {
        args.push(integerList(req.query[field]));
        where += ` AND ${field === "exclude" ? "NOT " : ""}(${column}=ANY($${args.length}::int[]))`;
      }
    for (const [field, taxonomy] of [
      ["categories", "category"],
      ["tags", "tag"],
    ] as const)
      if (req.query[field] !== undefined) {
        args.push(integerList(req.query[field]));
        where += ` AND EXISTS(SELECT 1 FROM post_terms pt JOIN terms t ON t.id=pt.term_id WHERE pt.post_id=p.id AND t.taxonomy='${taxonomy}' AND t.id=ANY($${args.length}::int[]))`;
      }
    for (const [field, operator] of [
      ["after", ">"],
      ["before", "<"],
    ] as const)
      if (req.query[field]) {
        args.push(z.iso.datetime({ offset: true }).parse(req.query[field]));
        where += ` AND coalesce(p.published_at,p.created_at)${operator}$${args.length}`;
      }
    const total = (
      await pool.query(
        `SELECT count(*)::int AS total FROM posts p WHERE ${where}`,
        args,
      )
    ).rows[0].total;
    const { perPage, offset } = pagination(req, res, total);
    const order = z
        .enum(["asc", "desc"])
        .default("desc")
        .parse(req.query.order),
      orderby = z
        .enum(["date", "modified", "title", "id", "slug", "menu_order"])
        .default("date")
        .parse(req.query.orderby);
    const column = {
      date: "coalesce(p.published_at,p.created_at)",
      modified: "p.updated_at",
      title: "p.title",
      id: "p.id",
      slug: "p.slug",
      menu_order: "p.menu_order",
    }[orderby];
    args.push(perPage, offset);
    const rows = (
      await pool.query(
        `SELECT ${postFields}${edit ? ',p.raw_content AS "rawContent"' : ""} FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where} ORDER BY ${column} ${order},p.id ${order} LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
      )
    ).rows;
    res.json(
      wpFields(
        req,
        await Promise.all(rows.map((post) => wpPost(post, req, edit))),
      ),
    );
  });
  router.get(
    "/wp-json/wp/v2/" + collection + "/:id",
    async (req: AuthRequest, res) => {
      const post = await getPost(parseId(req.params.id));
      if (!post || post.type !== type)
        throw new HttpError(404, "Post not found.");
      const edit = req.query.context === "edit";
      if (post.status !== "publish" && !canEdit(req.user, post))
        throw new HttpError(req.user ? 403 : 401, "You cannot read this post.");
      if (edit && !canEdit(req.user, post))
        throw new HttpError(req.user ? 403 : 401, "You cannot edit this post.");
      res.json(wpFields(req, await wpPost(post, req, edit)));
    },
  );
  const mutation = async (req: AuthRequest, res: Response) => {
    const user = needUser(req);
    if (
      !["administrator", "editor", "author", "contributor"].includes(user.role)
    )
      throw new HttpError(403, "You cannot create content.");
    const data = z
      .object({
        title: z.union([z.string(), z.object({ raw: z.string() })]).optional(),
        content: z
          .union([z.string(), z.object({ raw: z.string() })])
          .optional(),
        excerpt: z
          .union([z.string(), z.object({ raw: z.string() })])
          .optional(),
        slug: z.string().optional(),
        status: z
          .enum(["publish", "draft", "pending", "future", "private", "trash"])
          .optional(),
        date: z.string().nullable().optional(),
        date_gmt: z.string().nullable().optional(),
        password: z.string().optional(),
        parent: z.number().int().min(0).optional(),
        menu_order: z.number().int().optional(),
        featured_media: z.number().int().min(0).optional(),
        comment_status: z.enum(["open", "closed"]).optional(),
        sticky: z.boolean().optional(),
        categories: z.array(z.number().int().positive()).optional(),
        tags: z.array(z.number().int().positive()).optional(),
        author: z.number().int().positive().optional(),
        meta: z.record(z.string(), z.unknown()).optional(),
        template: z.string().optional(),
        format: z
          .enum([
            "standard",
            "aside",
            "image",
            "video",
            "quote",
            "link",
            "gallery",
            "audio",
          ])
          .optional(),
      })
      .strict()
      .parse(req.body);
    if (data.author !== undefined && data.author !== user.id)
      throw new HttpError(
        400,
        "Author reassignment is not supported by this compatibility endpoint.",
      );
    const body: Record<string, unknown> = {};
    if (!req.params.id) body.type = type;
    for (const field of ["title", "content", "excerpt"] as const)
      if (data[field] !== undefined)
        body[field] =
          typeof data[field] === "string"
            ? data[field]
            : (data[field] as { raw: string }).raw;
    for (const field of [
      "slug",
      "status",
      "password",
      "sticky",
      "format",
    ] as const)
      if (data[field] !== undefined) body[field] = data[field];
    for (const [wp, core] of [
      ["parent", "parentId"],
      ["menu_order", "menuOrder"],
      ["featured_media", "featuredMediaId"],
      ["comment_status", "commentStatus"],
      ["categories", "categoryIds"],
      ["tags", "tagIds"],
    ] as const)
      if (data[wp] !== undefined)
        body[core] =
          ["parent", "featured_media"].includes(wp) && data[wp] === 0
            ? null
            : data[wp];
    if (data.date || data.date_gmt) {
      const date = z.iso
        .datetime({ offset: true })
        .parse((data.date_gmt || data.date)!.replace(/Z$/, "") + "Z");
      body[data.status === "future" ? "scheduledAt" : "publishedAt"] = date;
    }
    if (req.params.id) {
      const existing = await getPost(parseId(req.params.id));
      if (!existing || existing.type !== type)
        throw new HttpError(404, "Post not found.");
    }
    const result = await forward(
      req,
      "/posts" + (req.params.id ? "/" + parseId(req.params.id) : ""),
      req.params.id ? "PUT" : "POST",
      body,
    );
    res.status(result.status).json(await wpPost(result.data.post, req, true));
  };
  router.post("/wp-json/wp/v2/" + collection, mutation);
  router.post("/wp-json/wp/v2/" + collection + "/:id", mutation);
  router.put("/wp-json/wp/v2/" + collection + "/:id", mutation);
  router.patch("/wp-json/wp/v2/" + collection + "/:id", mutation);
  router.delete(
    "/wp-json/wp/v2/" + collection + "/:id",
    async (req: AuthRequest, res) => {
      needUser(req);
      const id = parseId(req.params.id),
        existing = await getPost(id);
      if (!existing || existing.type !== type)
        throw new HttpError(404, "Post not found.");
      const previous = await wpPost(existing, req, true);
      if (req.query.force === "true") {
        if (existing.status !== "trash")
          await forward(req, "/posts/" + id, "PUT", { status: "trash" });
        await forward(req, "/posts/" + id, "DELETE");
        res.json({ deleted: true, previous });
      } else {
        const result = await forward(req, "/posts/" + id, "PUT", {
          status: "trash",
        });
        res.json(await wpPost(result.data.post, req, true));
      }
    },
  );
}
async function wpMedia(item: any) {
  const s = await getSettings(),
    url = absolute(item.url || "/uploads/" + item.filename, s.siteUrl);
  return {
    id: item.id,
    date: iso(item.createdAt || item.created_at).replace(/Z$/, ""),
    slug: slugify(item.title),
    status: "inherit",
    type: "attachment",
    link: url,
    title: { rendered: esc(item.title) },
    author: item.authorId || item.author_id,
    description: { rendered: item.caption || "" },
    caption: { rendered: item.caption || "" },
    alt_text: item.alt,
    media_type: String(item.mimeType || item.mime_type).startsWith("image/")
      ? "image"
      : "file",
    mime_type: item.mimeType || item.mime_type,
    media_details: {
      width: item.width,
      height: item.height,
      file: item.filename,
      sizes: {},
    },
    post: 0,
    source_url: url,
  };
}
router.get("/wp-json/wp/v2/media", async (req, res) => {
  const total = (await pool.query("SELECT count(*)::int AS total FROM media"))
    .rows[0].total;
  const { perPage, offset } = pagination(req, res, total);
  const rows = (
    await pool.query(
      `SELECT ${mediaFields},author_id AS "authorId",width,height FROM media ORDER BY created_at DESC,id DESC LIMIT $1 OFFSET $2`,
      [perPage, offset],
    )
  ).rows;
  res.json(wpFields(req, await Promise.all(rows.map(wpMedia))));
});
router.get("/wp-json/wp/v2/media/:id", async (req, res) => {
  const item = (
    await pool.query(
      `SELECT ${mediaFields},author_id AS "authorId",width,height FROM media WHERE id=$1`,
      [parseId(req.params.id)],
    )
  ).rows[0];
  if (!item) throw new HttpError(404, "Media not found.");
  res.json(wpFields(req, await wpMedia(item)));
});
router.post("/wp-json/wp/v2/media", async (req: AuthRequest, res) => {
  needUser(req);
  const result = await forward(req, "/media", "POST", undefined, true);
  res.status(result.status).json(await wpMedia(result.data.media));
});
router.post("/wp-json/wp/v2/media/:id", async (req: AuthRequest, res) => {
  needUser(req);
  const input = z
    .object({
      title: z.string().optional(),
      caption: z.string().optional(),
      alt_text: z.string().optional(),
    })
    .strict()
    .parse(req.body);
  const result = await forward(req, "/media/" + parseId(req.params.id), "PUT", {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.caption === undefined ? {} : { caption: input.caption }),
    ...(input.alt_text === undefined ? {} : { alt: input.alt_text }),
  });
  res.json(await wpMedia(result.data.media));
});
router.delete("/wp-json/wp/v2/media/:id", async (req: AuthRequest, res) => {
  needUser(req);
  const id = parseId(req.params.id),
    item = (
      await pool.query(`SELECT ${mediaFields} FROM media WHERE id=$1`, [id])
    ).rows[0];
  if (!item) throw new HttpError(404, "Media not found.");
  const previous = await wpMedia(item);
  await forward(req, "/media/" + id, "DELETE");
  res.json({ deleted: true, previous });
});
const wpTerm = (term: any, siteUrl: string, base: string) => ({
  id: term.id,
  count: term.count,
  description: term.description,
  link: absolute(
    "/" + base + "/" + encodeURIComponent(term.slug) + "/",
    siteUrl,
  ),
  name: term.name,
  slug: term.slug,
  taxonomy: term.taxonomy === "tag" ? "post_tag" : "category",
  parent: term.parentId || 0,
  meta: [],
});
for (const collection of ["categories", "tags"] as const) {
  const taxonomy = collection === "tags" ? "tag" : "category";
  router.get("/wp-json/wp/v2/" + collection, async (req, res) => {
    const settings = await getSettings(),
      args: unknown[] = [taxonomy];
    let where = "t.taxonomy=$1";
    if (req.query.slug !== undefined) {
      args.push(z.string().max(2000).parse(req.query.slug).split(","));
      where += ` AND t.slug=ANY($${args.length}::text[])`;
    }
    if (req.query.search !== undefined) {
      args.push("%" + z.string().max(200).parse(req.query.search) + "%");
      where += ` AND t.name ILIKE $${args.length}`;
    }
    if (req.query.hide_empty === "true")
      where +=
        " AND EXISTS(SELECT 1 FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.status='publish')";
    const total = (
      await pool.query(
        `SELECT count(*)::int AS total FROM terms t WHERE ${where}`,
        args,
      )
    ).rows[0].total;
    const { perPage, offset } = pagination(req, res, total);
    args.push(perPage, offset);
    const terms = (
      await pool.query(
        `SELECT t.id,t.taxonomy,t.name,t.slug,t.description,t.parent_id AS "parentId",(SELECT count(*)::int FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.status='publish') AS count FROM terms t WHERE ${where} ORDER BY t.name,t.id LIMIT $${args.length - 1} OFFSET $${args.length}`,
        args,
      )
    ).rows;
    res.json(
      wpFields(
        req,
        terms.map((t) =>
          wpTerm(
            t,
            settings.siteUrl,
            taxonomy === "category" ? settings.categoryBase : settings.tagBase,
          ),
        ),
      ),
    );
  });
  router.get("/wp-json/wp/v2/" + collection + "/:id", async (req, res) => {
    const settings = await getSettings(),
      term = (
        await pool.query(
          `SELECT t.id,t.taxonomy,t.name,t.slug,t.description,t.parent_id AS "parentId",(SELECT count(*)::int FROM post_terms pt JOIN posts p ON p.id=pt.post_id WHERE pt.term_id=t.id AND p.status='publish') AS count FROM terms t WHERE t.id=$1 AND t.taxonomy=$2`,
          [parseId(req.params.id), taxonomy],
        )
      ).rows[0];
    if (!term) throw new HttpError(404, "Term not found.");
    res.json(
      wpFields(
        req,
        wpTerm(
          term,
          settings.siteUrl,
          taxonomy === "category" ? settings.categoryBase : settings.tagBase,
        ),
      ),
    );
  });
  const save = async (req: AuthRequest, res: Response) => {
    needUser(req);
    const input = z
      .object({
        name: z.string().optional(),
        slug: z.string().optional(),
        description: z.string().optional(),
        parent: z.number().int().min(0).optional(),
      })
      .strict()
      .parse(req.body);
    const body: Record<string, unknown> = { ...input };
    delete body.parent;
    if (input.parent !== undefined) body.parentId = input.parent || null;
    if (!req.params.id) body.taxonomy = taxonomy;
    else {
      const existing = (
        await pool.query("SELECT taxonomy FROM terms WHERE id=$1", [
          parseId(req.params.id),
        ])
      ).rows[0];
      if (existing?.taxonomy !== taxonomy)
        throw new HttpError(404, "Term not found.");
    }
    const result = await forward(
        req,
        "/terms" + (req.params.id ? "/" + parseId(req.params.id) : ""),
        req.params.id ? "PUT" : "POST",
        body,
      ),
      settings = await getSettings();
    res
      .status(result.status)
      .json(
        wpTerm(
          result.data.term,
          settings.siteUrl,
          taxonomy === "category" ? settings.categoryBase : settings.tagBase,
        ),
      );
  };
  router.post("/wp-json/wp/v2/" + collection, save);
  router.post("/wp-json/wp/v2/" + collection + "/:id", save);
  router.put("/wp-json/wp/v2/" + collection + "/:id", save);
  router.patch("/wp-json/wp/v2/" + collection + "/:id", save);
  router.delete(
    "/wp-json/wp/v2/" + collection + "/:id",
    async (req: AuthRequest, res) => {
      needUser(req);
      const id = parseId(req.params.id),
        term = (
          await pool.query(
            'SELECT id,taxonomy,name,slug,description,parent_id AS "parentId" FROM terms WHERE id=$1',
            [id],
          )
        ).rows[0];
      if (!term || term.taxonomy !== taxonomy)
        throw new HttpError(404, "Term not found.");
      await forward(req, "/terms/" + id, "DELETE");
      const s = await getSettings();
      res.json({
        deleted: true,
        previous: wpTerm(
          term,
          s.siteUrl,
          taxonomy === "category" ? s.categoryBase : s.tagBase,
        ),
      });
    },
  );
}
function wpComment(comment: any, edit = false) {
  return {
    id: comment.id,
    post: comment.postId,
    parent: comment.parentId || 0,
    author: 0,
    author_name: comment.authorName,
    ...(edit ? { author_email: comment.authorEmail } : {}),
    author_url: "",
    date: iso(comment.createdAt).replace(/Z$/, ""),
    date_gmt: iso(comment.createdAt).replace(/Z$/, ""),
    content: {
      rendered: comment.content,
      ...(edit ? { raw: comment.content } : {}),
    },
    link: "",
    status:
      comment.status === "approved"
        ? "approved"
        : comment.status === "pending"
          ? "hold"
          : comment.status,
    type: "comment",
    author_avatar_urls: {},
    meta: [],
  };
}
router.get("/wp-json/wp/v2/comments", async (req: AuthRequest, res) => {
  const edit = req.query.context === "edit";
  if (
    edit &&
    (!req.user || !["administrator", "editor"].includes(req.user.role))
  )
    throw new HttpError(req.user ? 403 : 401, "You cannot moderate comments.");
  const args: unknown[] = [];
  let where = edit
    ? "true"
    : "c.status='approved' AND p.status='publish' AND p.password_hash IS NULL";
  if (req.query.post !== undefined) {
    args.push(integerList(req.query.post));
    where += ` AND c.post_id=ANY($${args.length}::int[])`;
  }
  if (edit && req.query.status !== undefined) {
    const status = z
      .enum(["approved", "hold", "spam", "trash", "all"])
      .parse(req.query.status);
    if (status !== "all") {
      args.push(status === "hold" ? "pending" : status);
      where += ` AND c.status=$${args.length}`;
    }
  }
  const total = (
    await pool.query(
      `SELECT count(*)::int AS total FROM comments c JOIN posts p ON p.id=c.post_id WHERE ${where}`,
      args,
    )
  ).rows[0].total;
  const { perPage, offset } = pagination(req, res, total);
  args.push(perPage, offset);
  const rows = (
    await pool.query(
      `SELECT c.id,c.post_id AS "postId",c.parent_id AS "parentId",c.author_name AS "authorName",c.author_email AS "authorEmail",c.content,c.status,c.created_at AS "createdAt" FROM comments c JOIN posts p ON p.id=c.post_id WHERE ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT $${args.length - 1} OFFSET $${args.length}`,
      args,
    )
  ).rows;
  res.json(
    wpFields(
      req,
      rows.map((c) => wpComment(c, edit)),
    ),
  );
});
router.get("/wp-json/wp/v2/comments/:id", async (req: AuthRequest, res) => {
  const edit = req.query.context === "edit",
    moderator = req.user && ["administrator", "editor"].includes(req.user.role);
  if (edit && !moderator)
    throw new HttpError(req.user ? 403 : 401, "You cannot moderate comments.");
  const row = (
    await pool.query(
      `SELECT c.id,c.post_id AS "postId",c.parent_id AS "parentId",c.author_name AS "authorName",c.author_email AS "authorEmail",c.content,c.status,c.created_at AS "createdAt",p.status AS "postStatus",p.password_hash AS protected FROM comments c JOIN posts p ON p.id=c.post_id WHERE c.id=$1`,
      [parseId(req.params.id)],
    )
  ).rows[0];
  if (
    !row ||
    (!moderator &&
      (row.status !== "approved" ||
        row.postStatus !== "publish" ||
        row.protected))
  )
    throw new HttpError(404, "Comment not found.");
  res.json(wpFields(req, wpComment(row, edit)));
});
router.post("/wp-json/wp/v2/comments", async (req: AuthRequest, res) => {
  const input = z
    .object({
      post: z.number().int().positive(),
      parent: z.number().int().min(0).optional(),
      author_name: z.string().optional(),
      author_email: z.string().optional(),
      content: z.string(),
    })
    .strict()
    .parse(req.body);
  const result = await forward(req, "/public/comments", "POST", {
    postId: input.post,
    parentId: input.parent || null,
    authorName: input.author_name,
    authorEmail: input.author_email,
    content: input.content,
  });
  const row = (
    await pool.query(
      `SELECT id,post_id AS "postId",parent_id AS "parentId",author_name AS "authorName",content,status,created_at AS "createdAt" FROM comments WHERE id=$1`,
      [result.data.comment.id],
    )
  ).rows[0];
  res.status(201).json(wpComment(row));
});
router.post("/wp-json/wp/v2/comments/:id", async (req: AuthRequest, res) => {
  needUser(req);
  const input = z
    .object({
      status: z.enum([
        "approved",
        "approve",
        "hold",
        "unapproved",
        "spam",
        "trash",
      ]),
    })
    .strict()
    .parse(req.body);
  const status = {
    approved: "approved",
    approve: "approved",
    hold: "pending",
    unapproved: "pending",
    spam: "spam",
    trash: "trash",
  }[input.status];
  const result = await forward(
    req,
    "/comments/" + parseId(req.params.id),
    "PUT",
    { status },
  );
  res.json(wpComment(result.data.comment, true));
});
router.delete("/wp-json/wp/v2/comments/:id", async (req: AuthRequest, res) => {
  needUser(req);
  await forward(req, "/comments/" + parseId(req.params.id), "DELETE");
  res.json({ deleted: true });
});
router.get("/wp-json/wp/v2/search", async (req, res) => {
  const search = z.string().max(200).default("").parse(req.query.search),
    args: unknown[] = ["%" + search + "%"];
  const where = "p.status='publish' AND p.title ILIKE $1";
  const total = (
    await pool.query(
      `SELECT count(*)::int AS total FROM posts p WHERE ${where}`,
      args,
    )
  ).rows[0].total;
  const { perPage, offset } = pagination(req, res, total);
  args.push(perPage, offset);
  const rows = (
      await pool.query(
        `SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE ${where} ORDER BY p.published_at DESC,p.id DESC LIMIT $2 OFFSET $3`,
        args,
      )
    ).rows,
    s = await getSettings();
  res.json(
    wpFields(
      req,
      await Promise.all(
        rows.map(async (p) => ({
          id: p.id,
          title: p.title,
          url: absolute(await postPermalink(p, s), s.siteUrl),
          type: "post",
          subtype: p.type,
        })),
      ),
    ),
  );
});
const types = {
  post: {
    slug: "post",
    name: "Posts",
    description: "Posts published in the site blog.",
    hierarchical: false,
    rest_base: "posts",
    rest_namespace: "wp/v2",
    taxonomies: ["category", "post_tag"],
  },
  page: {
    slug: "page",
    name: "Pages",
    description: "Hierarchical site pages.",
    hierarchical: true,
    rest_base: "pages",
    rest_namespace: "wp/v2",
    taxonomies: [],
  },
  attachment: {
    slug: "attachment",
    name: "Media",
    description: "Uploaded media files.",
    hierarchical: false,
    rest_base: "media",
    rest_namespace: "wp/v2",
    taxonomies: [],
  },
};
const taxonomies = {
  category: {
    slug: "category",
    name: "Categories",
    description: "Hierarchical post categories.",
    hierarchical: true,
    types: ["post"],
    rest_base: "categories",
    rest_namespace: "wp/v2",
  },
  post_tag: {
    slug: "post_tag",
    name: "Tags",
    description: "Post tags.",
    hierarchical: false,
    types: ["post"],
    rest_base: "tags",
    rest_namespace: "wp/v2",
  },
};
router.get("/wp-json/wp/v2/types", (_req, res) => res.json(types));
router.get("/wp-json/wp/v2/types/:type", (req, res) => {
  const value = types[req.params.type as keyof typeof types];
  if (!value) throw new HttpError(404, "Post type not found.");
  res.json(value);
});
router.get("/wp-json/wp/v2/taxonomies", (_req, res) => res.json(taxonomies));
router.get("/wp-json/wp/v2/taxonomies/:taxonomy", (req, res) => {
  const value = taxonomies[req.params.taxonomy as keyof typeof taxonomies];
  if (!value) throw new HttpError(404, "Taxonomy not found.");
  res.json(value);
});
router.get("/wp-json/wp/v2/statuses", (req: AuthRequest, res) =>
  res.json(
    Object.fromEntries(
      ["publish", "draft", "pending", "future", "private", "trash"]
        .filter(
          (status) =>
            status === "publish" ||
            (req.user &&
              ["administrator", "editor", "author", "contributor"].includes(
                req.user.role,
              )),
        )
        .map((slug) => [
          slug,
          {
            name: (
              {
                publish: "Published",
                draft: "Draft",
                pending: "Pending",
                future: "Scheduled",
                private: "Private",
                trash: "Trash",
              } as Record<string, string>
            )[slug],
            public: slug === "publish",
            private: slug === "private",
            protected: ["draft", "pending", "future"].includes(slug),
            slug,
          },
        ]),
    ),
  ),
);

router.get("/api/tools/export", admin, async (req, res, next) => {
  if (req.query.format !== "wxr") {
    next();
    return;
  }
  const s = await getSettings();
  const [posts, terms, comments, media] = await Promise.all([
    pool.query(
      `SELECT ${postFields},p.raw_content AS "rawContent",u.username,u.email AS "authorEmail" FROM posts p JOIN users u ON u.id=p.author_id ORDER BY p.id`,
    ),
    pool.query("SELECT * FROM terms ORDER BY id"),
    pool.query("SELECT * FROM comments ORDER BY id"),
    pool.query(
      "SELECT m.*,u.username FROM media m JOIN users u ON u.id=m.author_id ORDER BY m.id",
    ),
  ]);
  const authors = [...new Map(posts.rows.map((p) => [p.authorId, p])).values()]
    .map(
      (p) =>
        `<wp:author><wp:author_id>${p.authorId}</wp:author_id><wp:author_login>${cdata(p.username)}</wp:author_login><wp:author_email>${cdata(p.authorEmail)}</wp:author_email><wp:author_display_name>${cdata(p.authorName)}</wp:author_display_name><wp:author_first_name/><wp:author_last_name/></wp:author>`,
    )
    .join("");
  const termXml = terms.rows
    .map((t) =>
      t.taxonomy === "category"
        ? `<wp:category><wp:term_id>${t.id}</wp:term_id><wp:category_nicename>${cdata(t.slug)}</wp:category_nicename><wp:category_parent>${cdata(terms.rows.find((parent) => parent.id === t.parent_id)?.slug || "")}</wp:category_parent><wp:cat_name>${cdata(t.name)}</wp:cat_name><wp:category_description>${cdata(t.description)}</wp:category_description></wp:category>`
        : `<wp:tag><wp:term_id>${t.id}</wp:term_id><wp:tag_slug>${cdata(t.slug)}</wp:tag_slug><wp:tag_name>${cdata(t.name)}</wp:tag_name><wp:tag_description>${cdata(t.description)}</wp:tag_description></wp:tag>`,
    )
    .join("");
  const itemXml = await Promise.all(
    posts.rows.map(
      async (p) =>
        `<item><title>${cdata(p.title)}</title><link>${esc(absolute(await postPermalink(p, s), s.siteUrl))}</link><pubDate>${new Date(p.publishedAt || p.createdAt).toUTCString()}</pubDate><dc:creator>${cdata(p.username)}</dc:creator><guid isPermaLink="false">worldact:${p.id}</guid><description/><content:encoded>${cdata(p.rawContent || p.content)}</content:encoded><excerpt:encoded>${cdata(p.excerpt)}</excerpt:encoded><wp:post_id>${p.id}</wp:post_id><wp:post_date>${wpDate(p.publishedAt || p.scheduledAt || p.createdAt)}</wp:post_date><wp:post_date_gmt>${wpDate(p.publishedAt || p.scheduledAt || p.createdAt)}</wp:post_date_gmt><wp:post_modified>${wpDate(p.updatedAt)}</wp:post_modified><wp:post_modified_gmt>${wpDate(p.updatedAt)}</wp:post_modified_gmt><wp:comment_status>${p.commentStatus}</wp:comment_status><wp:ping_status>closed</wp:ping_status><wp:post_name>${cdata(p.slug)}</wp:post_name><wp:status>${p.hasPassword ? "draft" : p.status}</wp:status><wp:post_parent>${p.parentId || 0}</wp:post_parent><wp:menu_order>${p.menuOrder}</wp:menu_order><wp:post_type>${p.type}</wp:post_type><wp:post_password/><wp:is_sticky>${p.sticky ? 1 : 0}</wp:is_sticky>${p.hasPassword ? "<wp:postmeta><wp:meta_key>_worldact_password_protected</wp:meta_key><wp:meta_value>1</wp:meta_value></wp:postmeta>" : ""}${p.featuredMediaId ? `<wp:postmeta><wp:meta_key>_thumbnail_id</wp:meta_key><wp:meta_value>${p.featuredMediaId + 2147483648}</wp:meta_value></wp:postmeta>` : ""}${p.format && p.format !== "standard" ? `<category domain="post_format" nicename="post-format-${esc(p.format)}">${cdata(p.format)}</category>` : ""}${p.terms.map((t: any) => `<category domain="${t.taxonomy === "tag" ? "post_tag" : "category"}" nicename="${esc(t.slug)}">${cdata(t.name)}</category>`).join("")}${comments.rows
          .filter((c) => c.post_id === p.id)
          .map(
            (c) =>
              `<wp:comment><wp:comment_id>${c.id}</wp:comment_id><wp:comment_author>${cdata(c.author_name)}</wp:comment_author><wp:comment_author_email>${esc(c.author_email)}</wp:comment_author_email><wp:comment_date>${wpDate(c.created_at)}</wp:comment_date><wp:comment_date_gmt>${wpDate(c.created_at)}</wp:comment_date_gmt><wp:comment_content>${cdata(c.content)}</wp:comment_content><wp:comment_approved>${c.status === "approved" ? "1" : c.status === "pending" ? "0" : c.status}</wp:comment_approved><wp:comment_type/><wp:comment_parent>${c.parent_id || 0}</wp:comment_parent><wp:comment_user_id>0</wp:comment_user_id></wp:comment>`,
          )
          .join("")}</item>`,
    ),
  );
  const mediaXml = media.rows
    .map(
      (m) =>
        `<item><title>${cdata(m.title)}</title><content:encoded>${cdata(m.caption)}</content:encoded><wp:post_id>${m.id + 2147483648}</wp:post_id><wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status><wp:post_name>${cdata(m.filename)}</wp:post_name><wp:post_parent>0</wp:post_parent><wp:attachment_url>${esc(absolute("/uploads/" + m.filename, s.siteUrl))}</wp:attachment_url></item>`,
    )
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:wfw="http://wellformedweb.org/CommentAPI/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/"><channel><title>${esc(s.siteTitle)}</title><link>${esc(s.siteUrl)}</link><description>${esc(s.tagline)}</description><pubDate>${new Date().toUTCString()}</pubDate><language>en-US</language><wp:wxr_version>1.2</wp:wxr_version><wp:base_site_url>${esc(s.siteUrl)}</wp:base_site_url><wp:base_blog_url>${esc(s.siteUrl)}</wp:base_blog_url>${authors}${termXml}${itemXml.join("")}${mediaXml}</channel></rss>`;
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="worldact-export.xml"',
  );
  res.type("application/xml").send(xml);
});
router.post("/api/tools/import", admin, async (req: AuthRequest, res, next) => {
  if (req.body?.format !== "wxr") {
    next();
    return;
  }
  const { xml } = z
    .object({ format: z.literal("wxr"), xml: z.string().min(1).max(8_000_000) })
    .strict()
    .parse(req.body);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml))
    throw new HttpError(
      400,
      "DTD and entity declarations are not allowed in imports.",
    );
  if (XMLValidator.validate(xml) !== true)
    throw new HttpError(400, "The import must contain valid XML.");
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: true,
    maxNestedTags: 100,
  });
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    throw new HttpError(400, "The XML could not be parsed safely.");
  }
  const channel = doc?.rss?.channel;
  if (!channel || !text(channel["wp:wxr_version"]))
    throw new HttpError(400, "Choose a WordPress WXR export file.");
  const items = list(channel.item);
  if (items.length > 1000)
    throw new HttpError(400, "Import at most 1000 items at a time.");
  const client = await pool.connect();
  const termMap = new Map<string, number>(),
    postMap = new Map<number, number>(),
    createdTerms = new Set<number>(),
    createdPosts: number[] = [],
    createdComments: number[] = [];
  let skippedAttachments = 0,
    skippedItems = 0;
  function parsedDate(value: any) {
    const raw = text(value).trim();
    if (!raw || raw.startsWith("0000-")) return null;
    const date = new Date(raw.replace(" ", "T").replace(/Z$/, "") + "Z");
    if (!Number.isFinite(date.getTime()))
      throw new HttpError(
        400,
        "The export contains an invalid publication date.",
      );
    return date;
  }
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('worldact-wxr-import'))",
    );
    const definitions = [
      ...list(channel["wp:category"]).map((t: any) => ({
        taxonomy: "category",
        slug: text(t["wp:category_nicename"]),
        name: text(t["wp:cat_name"]),
        description: text(t["wp:category_description"]),
        parent: text(t["wp:category_parent"]),
      })),
      ...list(channel["wp:tag"]).map((t: any) => ({
        taxonomy: "tag",
        slug: text(t["wp:tag_slug"]),
        name: text(t["wp:tag_name"]),
        description: text(t["wp:tag_description"]),
        parent: "",
      })),
      ...list(channel["wp:term"])
        .filter((t: any) =>
          ["category", "post_tag"].includes(text(t["wp:term_taxonomy"])),
        )
        .map((t: any) => ({
          taxonomy:
            text(t["wp:term_taxonomy"]) === "category" ? "category" : "tag",
          slug: text(t["wp:term_slug"]),
          name: text(t["wp:term_name"]),
          description: text(t["wp:term_description"]),
          parent: "",
        })),
    ];
    if (definitions.length > 1000)
      throw new HttpError(400, "Import at most 1000 taxonomy terms at a time.");
    async function ensureTerm(
      taxonomy: string,
      slug: string,
      name: string,
      description = "",
    ) {
      slug = slugify(slug || name);
      const key = taxonomy + ":" + slug;
      if (termMap.has(key)) return termMap.get(key)!;
      name = plainText(name).trim().slice(0, 200) || slug;
      const existing = (
        await client.query(
          "SELECT id FROM terms WHERE taxonomy=$1 AND slug=$2",
          [taxonomy, slug],
        )
      ).rows[0];
      let id: number;
      if (existing) id = existing.id;
      else {
        const inserted = await client.query(
          "INSERT INTO terms(taxonomy,slug,name,description) VALUES($1,$2,$3,$4) RETURNING id",
          [taxonomy, slug, name, plainText(description).slice(0, 20000)],
        );
        id = inserted.rows[0].id;
        createdTerms.add(id);
        if (createdTerms.size > 1000)
          throw new HttpError(
            400,
            "Import at most 1000 new taxonomy terms at a time.",
          );
      }
      termMap.set(key, id);
      return id;
    }
    for (const term of definitions)
      await ensureTerm(term.taxonomy, term.slug, term.name, term.description);
    for (const term of definitions.filter(
      (t) => t.taxonomy === "category" && t.parent,
    )) {
      const seen = new Set<string>([term.slug]);
      let current = term.parent;
      while (current) {
        if (seen.has(current))
          throw new HttpError(400, "Imported categories cannot form a cycle.");
        seen.add(current);
        current =
          definitions.find(
            (t) => t.taxonomy === "category" && t.slug === current,
          )?.parent || "";
      }
      const id = termMap.get("category:" + slugify(term.slug)),
        parent = termMap.get("category:" + slugify(term.parent));
      if (id && parent && createdTerms.has(id))
        await client.query("UPDATE terms SET parent_id=$1 WHERE id=$2", [
          parent,
          id,
        ]);
    }
    const contentItems = items.filter((item: any) => {
      const type = text(item["wp:post_type"]);
      if (type === "attachment") {
        skippedAttachments++;
        return false;
      }
      if (
        !["post", "page"].includes(type) ||
        ["auto-draft", "inherit"].includes(text(item["wp:status"]))
      ) {
        skippedItems++;
        return false;
      }
      return true;
    });
    const oldIds = new Set<number>();
    for (let index = 0; index < contentItems.length; index++) {
      const item = contentItems[index],
        oldId = zero(item["wp:post_id"]) || index + 1;
      if (oldIds.has(oldId))
        throw new HttpError(400, "Imported post IDs must be unique.");
      oldIds.add(oldId);
      const type = text(item["wp:post_type"]),
        title = plainText(text(item.title)).slice(0, 300),
        base = slugify(text(item["wp:post_name"]) || title);
      let slug = base;
      if (
        (await client.query("SELECT id FROM posts WHERE slug=$1", [slug]))
          .rowCount
      )
        slug = base.slice(0, 170) + "-import-" + randomBytes(5).toString("hex");
      const raw = cleanRawContent(
          z.string().max(1_000_000).parse(text(item["content:encoded"])),
        ),
        content = cleanContent(raw),
        excerpt = plainText(text(item["excerpt:encoded"])).slice(0, 20000),
        date = parsedDate(item["wp:post_date_gmt"] || item["wp:post_date"]);
      let status = text(item["wp:status"]) || "draft";
      if (
        !["publish", "draft", "pending", "future", "private", "trash"].includes(
          status,
        )
      )
        status = "draft";
      const protectedFlag = list(item["wp:postmeta"]).some(
        (meta: any) =>
          text(meta["wp:meta_key"]) === "_worldact_password_protected" &&
          text(meta["wp:meta_value"]) === "1",
      );
      const password = text(item["wp:post_password"]);
      if (protectedFlag && !password) status = "draft";
      if (status === "future" && !date) status = "draft";
      const passwordHash = password
        ? await hashPassword(password.slice(0, 1024))
        : null;
      const inserted = await client.query(
        `INSERT INTO posts(type,title,slug,content,raw_content,excerpt,status,author_id,published_at,scheduled_at,menu_order,comment_status,sticky,password_hash,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,coalesce($15,now()),coalesce($16,now())) RETURNING id`,
        [
          type,
          title,
          slug,
          content,
          raw,
          excerpt,
          status,
          needUser(req).id,
          status === "publish" || status === "private"
            ? date || new Date()
            : null,
          status === "future" ? date : null,
          Math.max(
            -2147483648,
            Math.min(2147483647, zero(item["wp:menu_order"])),
          ),
          text(item["wp:comment_status"]) === "closed" ? "closed" : "open",
          text(item["wp:is_sticky"]) === "1",
          passwordHash,
          date,
          parsedDate(item["wp:post_modified_gmt"] || item["wp:post_modified"]),
        ],
      );
      const id = inserted.rows[0].id;
      const importedFormat = text(
        list(item.category).find(
          (term: any) => text(term["@_domain"]) === "post_format",
        )?.["@_nicename"],
      ).replace(/^post-format-/, "");
      if (
        type === "post" &&
        [
          "aside",
          "image",
          "video",
          "quote",
          "link",
          "gallery",
          "audio",
        ].includes(importedFormat)
      )
        await client.query("UPDATE posts SET format=$1 WHERE id=$2", [
          importedFormat,
          id,
        ]);
      createdPosts.push(id);
      postMap.set(oldId, id);
      if (type === "post") {
        let categoryCount = 0;
        for (const term of list(item.category)) {
          const domain = text(term["@_domain"]);
          if (!["category", "post_tag"].includes(domain)) continue;
          const taxonomy = domain === "category" ? "category" : "tag";
          const termId = await ensureTerm(
            taxonomy,
            text(term["@_nicename"]),
            text(term),
          );
          await client.query(
            "INSERT INTO post_terms(post_id,term_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [id, termId],
          );
          if (taxonomy === "category") categoryCount++;
        }
        if (!categoryCount)
          await client.query(
            "INSERT INTO post_terms(post_id,term_id) SELECT $1,id FROM terms WHERE is_default ON CONFLICT DO NOTHING",
            [id],
          );
      }
      const commentMap = new Map<number, number>(),
        commentDefinitions = list(item["wp:comment"]);
      if (commentDefinitions.length > 2000)
        throw new HttpError(400, "Import at most 2000 comments per post.");
      for (let ci = 0; ci < commentDefinitions.length; ci++) {
        const comment = commentDefinitions[ci];
        if (
          text(comment["wp:comment_type"]) &&
          !["comment", ""].includes(text(comment["wp:comment_type"]))
        )
          continue;
        const oldComment = zero(comment["wp:comment_id"]) || ci + 1;
        if (commentMap.has(oldComment))
          throw new HttpError(
            400,
            "Imported comment IDs must be unique within a post.",
          );
        const status =
          (
            {
              "1": "approved",
              "0": "pending",
              spam: "spam",
              trash: "trash",
            } as Record<string, string>
          )[text(comment["wp:comment_approved"])] || "pending";
        const row = await client.query(
          "INSERT INTO comments(post_id,author_name,author_email,content,status,created_at) VALUES($1,$2,$3,$4,$5,coalesce($6,now())) RETURNING id",
          [
            id,
            plainText(text(comment["wp:comment_author"])).slice(0, 160) ||
              "Anonymous",
            plainText(text(comment["wp:comment_author_email"])).slice(0, 254),
            cleanContent(text(comment["wp:comment_content"]).slice(0, 20000)),
            status,
            parsedDate(
              comment["wp:comment_date_gmt"] || comment["wp:comment_date"],
            ),
          ],
        );
        commentMap.set(oldComment, row.rows[0].id);
        createdComments.push(row.rows[0].id);
        if (createdComments.length > 10000)
          throw new HttpError(400, "Import at most 10000 comments at a time.");
      }
      for (let ci = 0; ci < commentDefinitions.length; ci++) {
        const comment = commentDefinitions[ci],
          oldComment = zero(comment["wp:comment_id"]) || ci + 1,
          parent = zero(comment["wp:comment_parent"]);
        if (!parent) continue;
        const seen = new Set<number>([oldComment]);
        let ancestor = parent;
        while (ancestor) {
          if (seen.has(ancestor))
            throw new HttpError(400, "Imported comments cannot form a cycle.");
          seen.add(ancestor);
          const definition = commentDefinitions.find(
            (c: any, index: number) =>
              (zero(c["wp:comment_id"]) || index + 1) === ancestor,
          );
          ancestor = definition ? zero(definition["wp:comment_parent"]) : 0;
        }
        if (commentMap.has(parent) && commentMap.has(oldComment))
          await client.query("UPDATE comments SET parent_id=$1 WHERE id=$2", [
            commentMap.get(parent),
            commentMap.get(oldComment),
          ]);
      }
    }
    for (let index = 0; index < contentItems.length; index++) {
      const item = contentItems[index],
        oldId = zero(item["wp:post_id"]) || index + 1,
        parent = zero(item["wp:post_parent"]);
      if (text(item["wp:post_type"]) !== "page" || !parent) continue;
      const seen = new Set<number>([oldId]);
      let ancestor = parent;
      while (ancestor) {
        if (seen.has(ancestor))
          throw new HttpError(400, "Imported pages cannot form a cycle.");
        seen.add(ancestor);
        const definition = contentItems.find(
          (p: any, i: number) => (zero(p["wp:post_id"]) || i + 1) === ancestor,
        );
        if (definition && text(definition["wp:post_type"]) !== "page")
          throw new HttpError(400, "A page parent must be a page.");
        ancestor = definition ? zero(definition["wp:post_parent"]) : 0;
      }
      if (postMap.has(parent))
        await client.query("UPDATE posts SET parent_id=$1 WHERE id=$2", [
          postMap.get(parent),
          postMap.get(oldId),
        ]);
    }
    await client.query("COMMIT");
    res.status(201).json({
      ok: true,
      imported: createdPosts.length,
      postIds: createdPosts,
      termIds: [...createdTerms],
      commentIds: createdComments,
      skippedAttachments,
      skippedItems,
      warnings: skippedAttachments
        ? [
            "Remote attachment files are not downloaded. Imported block HTML retains original media URLs; upload files in Media to migrate them.",
          ]
        : [],
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
router.use("/wp-json", (_req, res) =>
  res.status(404).json({
    code: "rest_no_route",
    message: "No route was found matching the URL and request method.",
    data: { status: 404 },
  }),
);
router.use((error: any, req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith("/wp-json")) {
    next(error);
    return;
  }
  const status =
    error instanceof HttpError
      ? error.status
      : error instanceof z.ZodError
        ? 400
        : 500;
  res.status(status).json({
    code:
      status === 401
        ? "rest_not_logged_in"
        : status === 403
          ? "rest_forbidden"
          : status === 404
            ? "rest_not_found"
            : status === 400
              ? "rest_invalid_param"
              : "rest_error",
    message:
      status === 500
        ? "The compatibility request could not be completed."
        : error.message,
    data: { status },
  });
});
export default router;
