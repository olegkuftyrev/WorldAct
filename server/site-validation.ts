import {pingServicesSchema} from "./outgoing-ping-settings.js";
import { z } from "zod";
import { templatePartAreas } from "../shared/template-areas.js";
import { postFormats } from "../shared/post-formats.js";
import { HttpError, plainText } from "./utils.js";
import { normalizeFixedTimezone } from "./timezone.js";
import { permalinkIdentityPattern, permalinkTokenHelp, permalinkTokenPattern } from "../shared/permalink-tokens.js";
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const id = z.number().int().positive().max(2147483647);
const nullableId = id.nullable();
const safeUrl = z.string().max(2000).refine(s => !s || (/^(https?:\/\/|\/|#|mailto:)/i.test(s) && !s.startsWith("//")), "Use an HTTP(S), relative, or email URL.");
export function normalizedText(value: string) { const clean = plainText(value).trim(); if (!clean) throw new HttpError(400, "Enter meaningful text."); return clean; }
export function validateExtensionSettings(slug: string, value: unknown) {
  if(slug === "hello-dolly")return z.object({}).strict().parse(value);
  if(slug === "akismet")return z.object({sendComments:z.boolean()}).strict().parse(value);
  if (slug === "reading-time") return z.object({ wordsPerMinute: z.number().int().min(50).max(1000) }).strict().parse(value);
  if (slug === "spam-shield") return z.object({ maxLinks: z.number().int().min(0).max(30) }).strict().parse(value);
  if (slug === "site-seo") return z.object({ description: z.string().max(500), siteImage: safeUrl }).strict().parse(value);
  if (slug === "custom-footer") return z.object({ text: z.string().max(2000) }).strict().parse(value);
  throw new HttpError(400, "This extension is not in the supported local registry.");
}
export const settingSchema = z
  .object({
    siteTitle: text(1, 200),
    tagline: z.string().max(500),
    siteUrl: z
      .url()
      .max(2000)
      .refine((v) => /^https?:\/\//i.test(v)),
    adminEmail: z.email().max(254),
    usersCanRegister: z.boolean(),
    defaultRole: z.enum([
      "administrator",
      "editor",
      "author",
      "contributor",
      "subscriber",
    ]),
    siteLogoId: z.number().int().min(0).max(2147483647),
    siteIconId: z.number().int().min(0).max(2147483647),
    timezone: text(1, 100).refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }).transform(normalizeFixedTimezone),
    dateFormat: text(1, 80),
    timeFormat: text(1, 80),
    weekStartsOn:z.number().int().min(0).max(6),
    postsPerPage: z.number().int().min(1).max(100),
    discourageSearchEngines: z.boolean(),
    theme: z.enum([
      "twentytwentyfive",
      "twentytwentyfour",
      "twentytwentythree",
      "classic",
    ]),
    defaultCategoryId: nullableId,
    defaultPingbackFlag: z.boolean(),
    pingServices: pingServicesSchema,
    defaultPostFormat: z.enum(postFormats),
    frontPageMode: z.enum(["posts", "page"]),
    frontPageId: nullableId,
    postsPageId: nullableId,
    feedItems: z.number().int().min(1).max(100),
    feedExcerpt: z.boolean(),
    defaultCommentStatus: z.enum(["open", "closed"]),
    defaultPingStatus: z.enum(["open", "closed"]),
    requireCommentNameEmail: z.boolean(),
    commentRegistration: z.boolean(),
    commentModeration: z.boolean(),
    commentMaxLinks: z.number().int().min(0).max(100),
    commentModerationKeys: z.string().max(20000),
    disallowedCommentKeys: z.string().max(20000),
    commentPreviouslyApproved: z.boolean(),
    notifyComments: z.boolean(),
    notifyModeration: z.boolean(),
    showAvatars: z.boolean(),
    avatarRating: z.enum(["G", "PG", "R", "X"]),
    defaultAvatar: z.enum(["mystery", "blank", "identicon", "wavatar", "monsterid", "retro"]),
    commentCookieConsent: z.boolean(),
    paginateComments: z.boolean(),
    defaultCommentPage: z.enum(["oldest", "newest"]),
    commentsPerPage: z.number().int().min(1).max(200),
    threadComments: z.boolean(),
    threadDepth: z.number().int().min(1).max(10),
    closeCommentsDays: z.number().int().min(0).max(3650),
    commentOrder: z.enum(["asc", "desc"]),
    permalinkStructure: text(0, 200).refine((s) => {
      if(s === "") return true;
      const tokens = s.match(/%[^%]+%/g) || [];
      return (
        s.startsWith("/") &&
        !/[?#<>\\\s]/.test(s) &&
        !s.includes("//") &&
        !s.split("/").includes("..") &&
        !/^\/(api|admin|uploads|wp-json|login|lost-password|reset-password)(\/|$)/.test(
          s,
        ) &&
        permalinkIdentityPattern.test(s) &&
        new Set(tokens).size === tokens.length &&
        (!s.includes("%author%") || s.split("/").includes("%author%")) &&
        !/%[^%]+%%/.test(s) &&
        !s
          .replace(permalinkTokenPattern(), "")
          .includes("%")
      );
    }, `Use an empty structure for Plain links, or a unique path beginning with / and containing %postname% or %post_id%. Supported tokens: ${permalinkTokenHelp}.`),
    categoryBase: text(1, 80).regex(/^[a-z0-9-]+$/),
    tagBase: text(1, 80).regex(/^[a-z0-9-]+$/),
    thumbnailWidth: z.number().int().min(0).max(4096),
    thumbnailCrop: z.boolean(),
    thumbnailHeight: z.number().int().min(0).max(4096),
    mediumWidth: z.number().int().min(0).max(8192),
    mediumHeight: z.number().int().min(0).max(8192),
    largeWidth: z.number().int().min(0).max(8192),
    largeHeight: z.number().int().min(0).max(8192),
    uploadsYearMonth: z.boolean(),
    privacyPageId: nullableId,
  })
  .partial()
  .strict();

export const menuSchema = z
  .object({
    name: text(1, 160),
    location: z.enum(["", "primary", "footer"]).default(""),
    items: z
      .array(
        z
          .object({
            id: text(1, 100),
            label: text(1, 200),
            url: safeUrl,
            parentId: z.string().max(100).nullable().optional(),
            target: z.enum(["_self", "_blank"]).optional(),
          })
          .strict(),
      )
      .max(200)
      .default([]),
  })
  .strict();
export function validMenu(items: z.infer<typeof menuSchema>["items"]) {
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length)
    throw new HttpError(400, "Menu item IDs must be unique.");
  for (const item of items) {
    if (item.parentId && !ids.has(item.parentId))
      throw new HttpError(400, "Choose an existing parent menu item.");
    let parent = item.parentId;
    const seen = new Set([item.id]);
    while (parent) {
      if (seen.has(parent))
        throw new HttpError(400, "Menu items cannot form a cycle.");
      seen.add(parent);
      parent = items.find((i) => i.id === parent)?.parentId;
    }
    item.label = normalizedText(item.label);
  }
}

export const styleSchema = z
  .object({
    backgroundColor: z.string().regex(/^#[a-f\d]{3,8}$/i),
    textColor: z.string().regex(/^#[a-f\d]{3,8}$/i),
    accentColor: z.string().regex(/^#[a-f\d]{3,8}$/i),
    fontFamily: z.string().min(1).max(120).regex(/^[\p{L}\p{N} ._'()-]+$/u),
    headingFont: z.string().min(1).max(120).regex(/^[\p{L}\p{N} ._'()-]+$/u),
    contentWidth: z.number().int().min(480).max(1800),
    spacing: z.number().int().min(8).max(80),
  })
  .partial()
  .strict();

export const documentSchema = z
  .object({
    slug: text(1, 160).regex(/^[a-z0-9-]+$/),
    title: text(1, 200),
    type: z.enum(["template", "template-part", "pattern"]),
    area: z.enum(templatePartAreas).optional(),
    content: z.string().max(1_000_000).default(""),
    blocks: z.unknown().optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();
