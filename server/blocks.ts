import express, { type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parse } from "@wordpress/block-serialization-default-parser";
import { pool, getSettings, postFields } from "./db.js";
import { attachUser, requireRole, type AuthRequest } from "./auth.js";
import {
  cleanBlocks,
  cleanContent,
  cleanRawContent,
  HttpError,
  needUser,
  parseId,
  plainText,
  slugify,
} from "./utils.js";
import {
  CORE_DYNAMIC_BLOCKS,
  SUPPORTED_DYNAMIC_BLOCKS,
  renderBlock,
  renderSiteDocument,
} from "./block-renderer.js";

const escapeHTML = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
const router = express.Router();
const admin = requireRole("administrator");
const editors = requireRole("administrator", "editor");
router.use(
  [
    "/wp-json/wp/v2/block-renderer",
    "/wp-json/wp/v2/block-types",
    "/wp-json/wp/v2/blocks",
    "/wp-json/wp/v2/navigation",
    "/wp-json/wp/v2/settings",
    "/wp-json/wp/v2/users",
    "/wp-json/wp/v2/themes",
    "/wp-json/wp/v2/menus",
    "/wp-json/wp/v2/menu-items",
    "/wp-json/wp/v2/types/wp_block",
    "/wp-json/wp/v2/types/wp_navigation",
    "/wp-json/wp/v2/template-parts",
  ],
  attachUser,
);
router.use("/wp-json", (req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers.origin !==
      new URL(process.env.APP_ORIGIN || "http://127.0.0.1:5173").origin
  )
    return res.status(403).json({
      code: "rest_cookie_invalid_origin",
      message: "This request must come from the configured site origin.",
      data: { status: 403 },
    });
  res.setHeader("Cache-Control", "no-store");
  next();
});
const iso = (date: any) => new Date(date).toISOString().replace(/Z$/, "");
const unwrap = (value: unknown) =>
  typeof value === "object" && value !== null && "raw" in value
    ? String((value as any).raw ?? "")
    : value;
function allow(req: AuthRequest, res: Response, collection = false) {
  const user = req.user;
  const can = user && ["administrator", "editor"].includes(user.role);
  res.setHeader(
    "Allow",
    can ? (collection ? "GET, POST" : "GET, POST, PUT, PATCH, DELETE") : "GET",
  );
  return !!can;
}
function entityRecord(row: any) {
  return {
    id: row.id,
    type: row.kind === "navigation" ? "wp_navigation" : "wp_block",
    date: iso(row.created_at),
    date_gmt: iso(row.created_at),
    modified: iso(row.updated_at),
    modified_gmt: iso(row.updated_at),
    slug: row.slug,
    status: row.status,
    title: { raw: row.title, rendered: escapeHTML(row.title) },
    content: { raw: row.raw_content, rendered: row.content, protected: false },
    author: row.author_id,
    version: row.version,
    meta: { wp_pattern_sync_status: "" },
    wp_pattern_sync_status: "",
    wp_pattern_category: [],
    _links: {
      self: [
        {
          href: `/wp-json/wp/v2/${row.kind === "navigation" ? "navigation" : "blocks"}/${row.id}`,
        },
      ],
    },
  };
}
const entityInput = z.object({
  title: z.preprocess(unwrap, z.string().max(200)).optional(),
  content: z.preprocess(unwrap, z.string().max(1_000_000)).optional(),
  status: z.enum(["publish", "draft", "trash"]).optional(),
  slug: z.string().max(220).optional(),
  version: z.number().int().positive().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
function durableBlocks(raw: string) {
  const convert = (nodes: ReturnType<typeof parse>): unknown[] =>
    nodes
      .filter((n) => n.blockName)
      .map((n) => ({
        name: n.blockName!,
        attributes: n.attrs || {},
        innerBlocks: convert(n.innerBlocks),
      }));
  return cleanBlocks(convert(parse(raw)));
}
for (const [base, kind] of [
  ["blocks", "reusable"],
  ["navigation", "navigation"],
] as const) {
  router.options(`/wp-json/wp/v2/${base}{/:id}`, (req: AuthRequest, res) => {
    allow(req, res, !req.params.id);
    res.json({
      schema: {
        properties: {
          title: { type: "object" },
          content: { type: "object" },
          status: { type: "string" },
        },
      },
    });
  });
  // Reusable patterns and navigation are editor entities. Public rendering resolves
  // published references internally; it never exposes raw entity content by ID.
  router.get(
    `/wp-json/wp/v2/${base}`,
    editors,
    async (req: AuthRequest, res) => {
      allow(req, res, true);
      const perPage = Math.max(
          1,
          Math.min(100, Number(req.query.per_page) || 100),
        ),
        page = Math.max(1, Math.min(10000, Number(req.query.page) || 1));
      const args: any[] = [kind],
        where = ["kind=$1", "status<>'trash'"];
      if (
        req.query.status &&
        ["publish", "draft", "trash"].includes(String(req.query.status))
      ) {
        args.push(req.query.status);
        where[1] = "status=$" + args.length;
      }
      if (req.query.search) {
        args.push("%" + String(req.query.search).slice(0, 200) + "%");
        where.push("title ILIKE $" + args.length);
      }
      if (req.query.include) {
        const include = String(req.query.include)
          .split(",")
          .map(Number)
          .filter(Number.isSafeInteger)
          .slice(0, 100);
        args.push(include);
        where.push("id=ANY($" + args.length + "::int[])");
      }
      const total = Number(
        (
          await pool.query(
            `SELECT count(*)::int AS total FROM block_entities WHERE ${where.join(" AND ")}`,
            args,
          )
        ).rows[0].total,
      );
      const rows = (
        await pool.query(
          `SELECT * FROM block_entities WHERE ${where.join(" AND ")} ORDER BY updated_at DESC,id DESC LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
          [...args, perPage, (page - 1) * perPage],
        )
      ).rows;
      res.setHeader("X-WP-Total", total);
      res.setHeader("X-WP-TotalPages", Math.ceil(total / perPage));
      res.json(rows.map(entityRecord));
    },
  );
  router.get(
    `/wp-json/wp/v2/${base}/:id`,
    editors,
    async (req: AuthRequest, res) => {
      allow(req, res);
      const row = (
        await pool.query(
          "SELECT * FROM block_entities WHERE kind=$1 AND id=$2",
          [kind, parseId(req.params.id)],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "This block entity does not exist.");
      res.json(entityRecord(row));
    },
  );
  router.post(
    `/wp-json/wp/v2/${base}`,
    editors,
    async (req: AuthRequest, res) => {
      const input = entityInput.parse(req.body),
        raw = cleanRawContent(input.content || ""),
        title = plainText(
          input.title ||
            (kind === "navigation" ? "Navigation" : "Untitled pattern"),
        );
      const entitySlug =
        slugify(input.slug || title) + "-" + randomBytes(4).toString("hex");
      const row = (
        await pool.query(
          "INSERT INTO block_entities(kind,title,slug,content,raw_content,blocks,status,author_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING *",
          [
            kind,
            title,
            entitySlug,
            cleanContent(raw),
            raw,
            JSON.stringify(durableBlocks(raw)),
            input.status || "publish",
            needUser(req).id,
          ],
        )
      ).rows[0];
      res.status(201).setHeader("Location", `/wp-json/wp/v2/${base}/${row.id}`);
      res.json(entityRecord(row));
    },
  );
  router.all(
    `/wp-json/wp/v2/${base}/:id`,
    editors,
    async (req: AuthRequest, res, next) => {
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method))
        return next();
      const id = parseId(req.params.id),
        db = await pool.connect();
      try {
        await db.query("BEGIN");
        const row = (
          await db.query(
            "SELECT * FROM block_entities WHERE kind=$1 AND id=$2 FOR UPDATE",
            [kind, id],
          )
        ).rows[0];
        if (!row) throw new HttpError(404, "This block entity does not exist.");
        if (req.method === "DELETE") {
          const previous = entityRecord(row);
          if (req.query.force === "true")
            await db.query("DELETE FROM block_entities WHERE id=$1", [id]);
          else
            await db.query(
              "UPDATE block_entities SET status='trash',version=version+1,updated_at=now() WHERE id=$1",
              [id],
            );
          await db.query("COMMIT");
          res.json({ deleted: true, previous });
          return;
        }
        const input = entityInput.parse(req.body);
        if (input.version !== undefined && input.version !== row.version)
          throw new HttpError(
            409,
            "This block was updated elsewhere. Reload before saving.",
          );
        const raw =
          input.content === undefined
            ? row.raw_content
            : cleanRawContent(input.content);
        const result = await db.query(
          "UPDATE block_entities SET title=$1,content=$2,raw_content=$3,blocks=$4::jsonb,status=$5,version=version+1,updated_at=now() WHERE id=$6 RETURNING *",
          [
            input.title === undefined ? row.title : plainText(input.title),
            cleanContent(raw),
            raw,
            JSON.stringify(durableBlocks(raw)),
            input.status || row.status,
            id,
          ],
        );
        await db.query("COMMIT");
        res.json(entityRecord(result.rows[0]));
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
    },
  );
}
const siteSchema = {
  title: { type: "string", title: "Site Title" },
  description: { type: "string", title: "Tagline" },
  site_logo: { type: "integer", title: "Site Logo" },
  site_icon: { type: "integer", title: "Site Icon" },
};
async function siteRecord() {
  const s: any = await getSettings();
  return {
    title: s.siteTitle,
    description: s.tagline,
    url: s.siteUrl,
    site_logo: s.siteLogoId || 0,
    site_icon: s.siteIconId || 0,
    timezone: s.timezone,
    date_format: s.dateFormat,
    time_format: s.timeFormat,
    posts_per_page: s.postsPerPage,
  };
}
router.options("/wp-json/wp/v2/settings", (req: AuthRequest, res) => {
  res.setHeader(
    "Allow",
    req.user?.role === "administrator" ? "GET, POST, PUT, PATCH" : "GET",
  );
  res.json({ schema: { properties: siteSchema } });
});
router.get("/wp-json/wp/v2/settings", admin, async (_req, res) => {
  res.setHeader("Allow", "GET, POST, PUT, PATCH");
  res.json(await siteRecord());
});
router.all(
  "/wp-json/wp/v2/settings",
  admin,
  async (req: AuthRequest, res, next) => {
    if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();
    const input = z
        .object({
          title: z.string().min(1).max(200).optional(),
          description: z.string().max(500).optional(),
          site_logo: z.number().int().min(0).optional(),
          site_icon: z.number().int().min(0).optional(),
        })
        .parse(req.body),
      data: Record<string, unknown> = {};
    if (input.title !== undefined) data.siteTitle = plainText(input.title);
    if (input.description !== undefined)
      data.tagline = plainText(input.description);
    for (const key of ["site_logo", "site_icon"] as const)
      if (input[key] !== undefined) {
        const id = input[key]!;
        if (
          id &&
          !(
            await pool.query(
              "SELECT id FROM media WHERE id=$1 AND mime_type LIKE 'image/%'",
              [id],
            )
          ).rowCount
        )
          throw new HttpError(400, "Choose an existing image.");
        data[key === "site_logo" ? "siteLogoId" : "siteIconId"] = id;
      }
    await pool.query("UPDATE settings SET data=data || $1::jsonb WHERE id=1", [
      JSON.stringify(data),
    ]);
    res.json(await siteRecord());
  },
);
router.get("/wp-json/wp/v2/users{/:id}", async (req: AuthRequest, res) => {
  const id = req.params.id ? parseId(req.params.id) : null;
  const include = String(req.query.include || "")
    .split(",")
    .map(Number)
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, 100);
  const rows = (
    await pool.query(
      `SELECT u.id,u.username,u.display_name,u.profile FROM users u WHERE ($1::int IS NULL OR u.id=$1) AND ($2::int[]='{}'::int[] OR u.id=ANY($2::int[])) AND EXISTS(SELECT 1 FROM posts p WHERE p.author_id=u.id AND p.status='publish' AND p.password_hash IS NULL) ORDER BY u.display_name,u.id LIMIT 100`,
      [id, include],
    )
  ).rows;
  const records = rows.map((u) => ({
    id: u.id,
    name: u.display_name,
    slug: u.username,
    description: u.profile?.bio || "",
    url: u.profile?.website || "",
    link: `/?author=${u.id}`,
    avatar_urls: {},
  }));
  if (id) {
    if (!records[0]) throw new HttpError(404, "Author not found.");
    res.json(records[0]);
  } else {
    res.setHeader("X-WP-Total", records.length);
    res.setHeader("X-WP-TotalPages", 1);
    res.json(records);
  }
});
router.get("/wp-json/wp/v2/menus", editors, async (_req, res) => {
  const rows = (
    await pool.query(
      "SELECT id,name,location FROM navigation_menus ORDER BY id",
    )
  ).rows;
  res.json(
    rows.map((row) => ({
      id: row.id,
      name: row.name,
      slug: slugify(row.name),
      description: "",
      locations: row.location ? [row.location] : [],
      auto_add: false,
    })),
  );
});
router.get("/wp-json/wp/v2/menu-items", editors, async (req, res) => {
  const menuId = Number(req.query.menus || req.query.menu),
    rows = (
      await pool.query(
        "SELECT id,items FROM navigation_menus WHERE ($1::int=0 OR id=$1) ORDER BY id",
        [Number.isSafeInteger(menuId) ? menuId : 0],
      )
    ).rows;
  const records: any[] = [];
  for (const menu of rows) {
    const ids = new Map<string, number>(
      (menu.items || []).map((item: any, index: number) => [
        item.id,
        menu.id * 10000 + index + 1,
      ]),
    );
    (menu.items || []).forEach((item: any, index: number) =>
      records.push({
        id: ids.get(item.id),
        title: { raw: item.label, rendered: escapeHTML(item.label) },
        url: item.url,
        type: "custom",
        object: "custom",
        object_id: 0,
        parent: ids.get(item.parentId) || 0,
        menu_order: index + 1,
        target: item.target || "",
        xfn: "",
        classes: [],
        menus: [menu.id],
        status: "publish",
      }),
    );
  }
  res.setHeader("X-WP-Total", records.length);
  res.setHeader("X-WP-TotalPages", 1);
  res.json(records);
});
router.get("/wp-json/wp/v2/themes", editors, async (_req, res) => {
  const s = await getSettings();
  res.json([
    {
      stylesheet: s.theme,
      template: s.theme,
      name: { raw: s.theme, rendered: s.theme },
      status: "active",
      is_block_theme: true,
      default_template_part_areas: [
        { area: "header", label: "Header", area_tag: "header" },
        { area: "footer", label: "Footer", area_tag: "footer" },
        { area: "uncategorized", label: "General", area_tag: "div" },
      ],
      theme_supports: {
        "block-templates": true,
        "post-thumbnails": true,
        formats: ["standard", "aside", "image", "video", "quote", "link", "gallery", "audio"],
      },
    },
  ]);
});
for (const [name, base, label] of [
  ["wp_block", "blocks", "Patterns"],
  ["wp_navigation", "navigation", "Navigation"],
] as const)
  router.get(`/wp-json/wp/v2/types/${name}`, editors, (_req, res) =>
    res.json({
      slug: name,
      name: label,
      rest_base: base,
      rest_namespace: "wp/v2",
      supports: { title: true, editor: true },
      viewable: false,
      taxonomies: [],
      hierarchical: false,
    }),
  );
function templatePartRecord(row: any, theme: string) {
  return {
    id: `${theme}//${row.slug}`,
    wp_id: row.id,
    slug: row.slug,
    theme,
    type: "wp_template_part",
    status: "publish",
    source: "custom",
    origin: "custom",
    is_custom: true,
    has_theme_file: false,
    title: { raw: row.title, rendered: escapeHTML(row.title) },
    content: { raw: row.rawContent || row.content, rendered: row.content },
    area: ["header", "footer"].includes(row.slug) ? row.slug : "uncategorized",
    version: row.version,
  };
}
router.options(
  "/wp-json/wp/v2/template-parts{/*id}",
  editors,
  (req: AuthRequest, res) => {
    allow(req, res, !req.params.id);
    res.json({
      schema: {
        properties: { title: { type: "object" }, content: { type: "object" } },
      },
    });
  },
);
router.get("/wp-json/wp/v2/template-parts{/*id}", editors, async (req, res) => {
  const settings = await getSettings();
  const itemSlug = req.params.id
    ? (Array.isArray(req.params.id)
        ? req.params.id.join("/")
        : String(req.params.id)
      )
        .split("//")
        .pop()
    : null;
  const docs = (
    await pool.query(
      `SELECT id,slug,title,content,raw_content AS "rawContent",version FROM site_documents WHERE type='template-part' AND ($1::text IS NULL OR slug=$1) ORDER BY title,id`,
      [itemSlug],
    )
  ).rows;
  const records = docs.map((doc) => templatePartRecord(doc, settings.theme));
  if (itemSlug) {
    if (!records[0]) throw new HttpError(404, "Template part not found.");
    res.setHeader("Allow", "GET, POST, PUT");
    res.json(records[0]);
  } else res.json(records);
});
router.all(
  "/wp-json/wp/v2/template-parts{/*id}",
  editors,
  async (req: AuthRequest, res, next) => {
    if (!["POST", "PUT", "PATCH"].includes(req.method)) return next();
    const input = entityInput.parse(req.body),
      settings = await getSettings(),
      raw =
        input.content === undefined
          ? undefined
          : cleanRawContent(input.content);
    const itemSlug = req.params.id
      ? (Array.isArray(req.params.id)
          ? req.params.id.join("/")
          : String(req.params.id)
        )
          .split("//")
          .pop()
      : slugify(input.slug || input.title || "template-part");
    if (!itemSlug || !/^[a-z0-9_-]{1,160}$/i.test(itemSlug))
      throw new HttpError(400, "Use a valid template part slug.");
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      let doc = (
        await db.query(
          "SELECT * FROM site_documents WHERE slug=$1 AND type='template-part' FOR UPDATE",
          [itemSlug],
        )
      ).rows[0];
      if (doc) {
        if (input.version !== undefined && input.version !== doc.version)
          throw new HttpError(
            409,
            "This template part was changed elsewhere. Reload before saving.",
          );
        doc = (
          await db.query(
            "UPDATE site_documents SET title=$1,content=$2,raw_content=$3,blocks=$4::jsonb,version=version+1,updated_at=now() WHERE id=$5 RETURNING *",
            [
              input.title === undefined ? doc.title : plainText(input.title),
              raw === undefined ? doc.content : cleanContent(raw),
              raw ?? doc.raw_content,
              JSON.stringify(
                raw === undefined ? doc.blocks : durableBlocks(raw),
              ),
              doc.id,
            ],
          )
        ).rows[0];
      } else {
        if (req.params.id) throw new HttpError(404, "Template part not found.");
        const value = raw || "";
        doc = (
          await db.query(
            "INSERT INTO site_documents(slug,title,type,content,raw_content,blocks) VALUES($1,$2,'template-part',$3,$4,$5::jsonb) RETURNING *",
            [
              itemSlug,
              plainText(input.title || "Template part"),
              cleanContent(value),
              value,
              JSON.stringify(durableBlocks(value)),
            ],
          )
        ).rows[0];
        res.status(201);
      }
      await db.query("COMMIT");
      res.json(
        templatePartRecord(
          { ...doc, rawContent: doc.raw_content },
          settings.theme,
        ),
      );
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    } finally {
      db.release();
    }
  },
);
const blockMetadata = new Map<string, Promise<any>>();
function metadata(name: string) {
  if (!blockMetadata.has(name)) {
    const require = createRequire(import.meta.url),
      directory = path.dirname(
        require.resolve("@wordpress/block-library/package.json"),
      );
    blockMetadata.set(
      name,
      readFile(
        path.join(directory, "build-module", name.slice(5), "block.json"),
        "utf8",
      )
        .then(JSON.parse)
        .then((block) => ({
          ...block,
          name,
          is_dynamic: SUPPORTED_DYNAMIC_BLOCKS.has(name),
          attributes: block.attributes || {},
          uses_context: block.usesContext || [],
          provides_context: block.providesContext || {},
          supports: block.supports || {},
          editor_script_handles: [],
          script_handles: [],
          style_handles: [],
        })),
    );
  }
  return blockMetadata.get(name)!;
}
router.get(
  "/wp-json/wp/v2/block-types{/:namespace}{/:block}",
  editors,
  async (req, res) => {
    const name = req.params.block
      ? `${req.params.namespace}/${req.params.block}`
      : null;
    if (name && !SUPPORTED_DYNAMIC_BLOCKS.has(name))
      throw new HttpError(404, "This dynamic block is not supported.");
    const records = await Promise.all(
      (name ? [name] : CORE_DYNAMIC_BLOCKS).map(metadata),
    );
    res.json(name ? records[0] : records);
  },
);
router.all(
  "/wp-json/wp/v2/block-renderer/:namespace/:block",
  async (req: AuthRequest, res, next) => {
    if (!["GET", "POST"].includes(req.method)) return next();
    const user = needUser(req);
    if (user.role === "subscriber")
      throw new HttpError(403, "You cannot edit blocks.");
    const name = `${req.params.namespace}/${req.params.block}`;
    if (!SUPPORTED_DYNAMIC_BLOCKS.has(name))
      throw new HttpError(404, "This dynamic block is not supported.");
    let attributes =
      req.method === "POST" ? req.body?.attributes : req.query.attributes;
    if (typeof attributes === "string") {
      if (attributes.length > 100000)
        throw new HttpError(400, "The block attributes are too large.");
      try {
        attributes = JSON.parse(attributes);
      } catch {
        throw new HttpError(400, "The block attributes must be valid JSON.");
      }
    }
    attributes = z.record(z.string(), z.unknown()).parse(attributes || {});
    const idValue =
      req.method === "POST" ? req.body?.post_id : req.query.post_id;
    let post = null;
    if (idValue) {
      const id = parseId(String(idValue));
      post = (
        await pool.query(
          `SELECT ${postFields} FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1`,
          [id],
        )
      ).rows[0];
      if (!post) throw new HttpError(404, "Post not found.");
      if (
        !["administrator", "editor"].includes(user.role) &&
        post.authorId !== user.id
      )
        throw new HttpError(403, "You cannot edit this post.");
    }
    res.json({ rendered: await renderBlock(name, attributes, { post }) });
  },
);
router.get("/api/public/templates/:slug", async (req, res) => {
  const templateSlug = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,160}$/)
      .parse(req.params.slug),
    type = req.query.type === "template-part" ? "template-part" : "template";
  const doc = (
    await pool.query(
      'SELECT id,slug,title,type,version,content,raw_content AS "rawContent",blocks FROM site_documents WHERE slug=$1 AND type=$2 LIMIT 1',
      [templateSlug, type],
    )
  ).rows[0];
  if (!doc) throw new HttpError(404, "Template not found.");
  let post = null;
  if (req.query.postId) {
    const id = parseId(String(req.query.postId));
    post = (
      await pool.query(
        `SELECT ${postFields},p.password_hash AS "passwordHash" FROM posts p JOIN users u ON u.id=p.author_id WHERE p.id=$1 AND p.status='publish'`,
        [id],
      )
    ).rows[0];
    if (!post) throw new HttpError(404, "Post not found.");
    if (post.hasPassword) {
      const token = req.headers.cookie
        ?.split(";")
        .map((c) => c.trim())
        .find((c) => c.startsWith(`worldact_post_${id}=`))
        ?.split("=")[1];
      const valid =
        token &&
        /^[a-f0-9]{64}$/.test(token) &&
        (
          await pool.query(
            "SELECT 1 FROM post_access_tokens WHERE post_id=$1 AND token_hash=$2 AND password_hash=$3 AND expires_at>now()",
            [
              id,
              createHash("sha256").update(token).digest("hex"),
              post.passwordHash,
            ],
          )
        ).rowCount;
      if (!valid)
        throw new HttpError(
          403,
          "Enter this post password before viewing its template.",
        );
      res.setHeader("Cache-Control", "private, no-store");
    }
    delete post.passwordHash;
  }
  const requestPath = String(req.query.requestPath || "/").slice(0, 2000);
  if (!requestPath.startsWith("/") || requestPath.startsWith("//"))
    throw new HttpError(400, "Use a site-relative request path.");
  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(req.query))
    if (
      !["postId", "requestPath", "type"].includes(key) &&
      typeof value === "string"
    )
      query[key] = value.slice(0, 300);
  res.json({
    document: {
      id: doc.id,
      slug: doc.slug,
      title: doc.title,
      type: doc.type,
      version: doc.version,
    },
    content: await renderSiteDocument(doc, {
      post,
      requestPath,
      query,
      page: Number(req.query.page) || 1,
      placeholderBindings: false,
    }),
  });
});
router.use(
  "/wp-json",
  (error: any, _req: Request, res: Response, _next: express.NextFunction) => {
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : 500;
    res.status(status).json({
      code:
        status === 403
          ? "rest_forbidden"
          : status === 404
            ? "rest_not_found"
            : "rest_invalid_param",
      message:
        status === 500
          ? "The block operation could not be completed."
          : error.message,
      data: { status },
    });
  },
);
export default router;
