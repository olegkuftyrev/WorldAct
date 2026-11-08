// Presentation-only types. All imports are erased; this module is safe in Node
// and the public browser entry without importing the admin/editor runtime.
import type { Post, Comment, Settings, NavigationMenu, SiteStyle, Role } from "../src/api.js";

export type PublicPost = Omit<Post, "blocks" | "rawContent" | "pendingCommentCount">;
export type PublicComment = Omit<Comment, "authorEmail" | "rawContent" | "permissions">;
export type PublicSettings = Partial<Pick<Settings,
  "siteTitle" | "tagline" | "siteUrl" | "usersCanRegister" | "siteLogoId" | "siteIconId" | "siteIconUrl" | "siteIconSizes"
  | "timezone" | "dateFormat" | "timeFormat" | "weekStartsOn" | "postsPerPage" | "discourageSearchEngines" | "theme"
  | "frontPageMode" | "frontPageId" | "postsPageId" | "requireCommentNameEmail" | "commentRegistration" | "commentsPerPage"
  | "threadComments" | "threadDepth" | "closeCommentsDays" | "commentOrder" | "permalinkStructure" | "categoryBase" | "tagBase" | "privacyPageId"
>> & {
  paginateComments?: boolean; commentCookieConsent?: boolean; showAvatars?: boolean;
};
export type PublicViewer = null | { id: number; displayName: string; role: Role; showAdminBar: boolean };
export type PublicArchive = { taxonomy: "category" | "tag"; slug: string; name?: string }
  | { type: "author"; name: string; authorId: number }
  | { type: "date"; year: number; month?: number; day?: number; week?: number; name: string; permalink: string };
export type PublicQuery = {
  search: string; category: string; tag: string; author?: number;
  date: Extract<PublicArchive, { type: "date" }> | null;
  archivePage: number; contentPage: number; commentPage?: number;
  blockPages: Record<string, number>;
  // A validated renderer query, without postId/requestPath/preview/access keys.
  values: Record<string, string>;
};
export type PublicRoute = {
  kind: "home" | "archive" | "singular" | "front-page" | "posts-page" | "not-found";
  archive: PublicArchive | null; query: PublicQuery;
  selectedId?: number; selectedType?: "post" | "page";
};
export type PublicTemplateRef = {
  id: number; slug: string; title: string; type: "template" | "template-part" | "pattern";
  version?: number; updatedAt?: string;
  isCustom?: boolean;
};
export type PublicDesign = {
  theme?: { id: string; name: string; version: string; css: string; themeJSON: Record<string, unknown> | null; variation: string };
  styles: Partial<SiteStyle>; templates: PublicTemplateRef[]; parts: PublicTemplateRef[];
  menus: NavigationMenu[]; plugins: { slug: string; settings: Record<string, unknown> }[];
};
export type PublicSite = {
  settings: PublicSettings; archive: PublicArchive | null; posts: PublicPost[]; pages: PublicPost[];
  frontPage: PublicPost | null; postsPage: PublicPost | null;
  pagination: { page: number; totalPosts: number; totalPages: number };
};
export type PublicCommentsPagination = {
  page: number; perPage: number; totalComments: number; totalTopLevelComments: number; totalPages: number;
};
export type PublicPresentation = { kind: "source"; document: PublicTemplateRef; html: string }
  | { kind: "classic"; slots: Partial<Record<"header" | "footer" | "single" | "index", { document: PublicTemplateRef; html: string }>> };
export type PublicHead = {
  title: string; robots: string | null; canonical: string | null;
  seo: null | { description: string; title: string; type: "article" | "website"; url: string; image: string | null };
  icons: { rel: string; href: string; sizes?: string }[];
};
export type PublicDocumentModel = {
  schema: 1; requestPath: string; status: 200 | 404; route: PublicRoute; viewer: PublicViewer;
  site: PublicSite; post: PublicPost | null; comments: PublicComment[];
  commentsPagination: PublicCommentsPagination | null; design: PublicDesign;
  presentation: PublicPresentation; head: PublicHead;
  controls: {
    commentsOpen: boolean; replyParentId: number; replyParentName: string | null;
    commentReturnPath: string; loginHref: string;
    // Nonsecret request-time lifecycle hint; never an authorization stamp.
    sensitive: boolean;
    dates: Record<string, string>;
  };
};
export type FrameworkDocument = { kind: "framework"; status: 200; requestPath: string };
