import type { PostFormat } from "../shared/post-formats";
export type Role =
  | "administrator"
  | "editor"
  | "author"
  | "contributor"
  | "subscriber";
export type User = {
  id: number;
  username: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  bio?: string;
  website?: string;
  adminColor?: string;
  locale?: string;
  showAdminBar?: boolean;
  commentShortcuts?: boolean;
};
export type SerializedBlock = {
  name: string;
  attributes: Record<string, unknown>;
  innerBlocks: SerializedBlock[];
};
export type PostStatus =
  | "publish"
  | "draft"
  | "pending"
  | "future"
  | "private"
  | "trash";
export type Term = {
  id: number;
  taxonomy: "category" | "tag";
  name: string;
  slug: string;
  description: string;
  parentId: number | null;
  count: number;
  isDefault?: boolean;
};
export type Footnote = { id: string; content: string };
export type Post = {
  contentPagination?: {page:number;totalPages:number;links:Array<{page:number;url:string;current:boolean}>};
  footnotes?: Footnote[];
  templateSlug?:string;
  id: number;
  type: "post" | "page";
  format: PostFormat;
  title: string;
  slug: string;
  content: string;
  rawContent?: string;
  permalink?: string;
  excerpt: string;
  status: PostStatus;
  authorId: number;
  authorName: string;
  commentCount?: number;
  approvedCommentCount?: number;
  pendingCommentCount?: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  scheduledAt: string | null;
  version: number;
  blocks: SerializedBlock[] | null;
  terms: Term[];
  categories: Term[];
  tags: Term[];
  categoryIds: number[];
  tagIds: number[];
  parentId: number | null;
  menuOrder: number;
  featuredMediaId: number | null;
  featuredMedia?: Media | null;
  commentStatus: "open" | "closed";
  sticky: boolean;
  hasPassword: boolean;
  locked?: boolean;
  readingTime?: number;
};
export type Revision = {
  footnotes?: Footnote[];
  id: number;
  postId: number;
  title: string;
  content: string;
  rawContent?: string;
  permalink?: string;
  excerpt: string;
  blocks: SerializedBlock[] | null;
  createdAt: string;
  authorName: string;
  version: number;
  slug: string;
  status: PostStatus;
};
export type Autosave = {
  footnotes?: Footnote[];
  title: string;
  content: string;
  rawContent?: string;
  permalink?: string;
  excerpt: string;
  blocks: SerializedBlock[] | null;
  savedAt: string;
  version: number;
};
export type AudioMetadata = {title?:string;artist?:string;album?:string;genre?:string;year?:number;length?:number;length_formatted?:string;bitrate?:number;sample_rate?:number;channels?:number;bits_per_sample?:number;codec?:string;fileformat?:string;lossless?:boolean;filesize?:number;mime_type?:string};
export type Media = {
  audioMetadata?: AudioMetadata;
  artworkMediaId?:number|null;
  image?:{id:number;src:string;alt:string;width:number;height:number}|null;
  id: number;
  title: string;
  url: string;
  mimeType: string;
  filename: string;
  alt: string;
  caption: string;
  size: number;
  width?: number | null;
  height?: number | null;
  canRestore?: boolean;
  originalUploadUrl?: string | null;
  sizes?: Record<
    string,
    {
      filename: string;
      url: string;
      width: number;
      height: number;
      mimeType: string;
    }
  >;
  createdAt: string;
  authorId?: number;
  authorName?: string;
  attachedPostId?: number | null;
  attachedPostTitle?: string | null;
  description?: string;
  commentStatus?: "open" | "closed";
};
export type Comment = {
  permissions?: { edit: boolean; reply: boolean; moderate: boolean; delete: boolean };
  id: number;
  authorName: string;
  avatarUrl?: string | null;
  authorEmail?: string;
  authorUrl?: string;
  userId?: number | null;
  version?: number;
  updatedAt?: string;
  content: string;
  rawContent?: string;
  permalink?: string;
  status: "approved" | "pending" | "spam" | "trash";
  postId: number;
  postTitle: string;
  createdAt: string;
  parentId?: number | null;
};
export type ThemeId =
  | "twentytwentyfive"
  | "twentytwentyfour"
  | "twentytwentythree"
  | "classic";
export type Settings = {
  siteTitle: string;
  tagline: string;
  siteUrl: string;
  adminEmail: string;
  usersCanRegister: boolean;
  defaultRole: Role;
  siteLogoId?: number;
  siteIconId?: number;
  siteIconUrl?: string | null;
  siteIconSizes?:Record<string,{url:string;width:number;height:number}>;
  weekStartsOn?:number;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  postsPerPage: number;
  discourageSearchEngines: boolean;
  theme: ThemeId;
  defaultCategoryId?: number;
  defaultPostFormat?: string;
  frontPageMode?: "posts" | "page";
  frontPageId?: number | null;
  postsPageId?: number | null;
  feedItems?: number;
  feedExcerpt?: boolean;
  defaultCommentStatus?: "open" | "closed";
  requireCommentNameEmail?: boolean;
  commentRegistration?: boolean;
  commentModeration?: boolean;
  commentsPerPage?: number;
  threadComments?: boolean;
  threadDepth?: number;
  closeCommentsDays?: number;
  commentOrder?: "asc" | "desc";
  permalinkStructure?: string;
  categoryBase?: string;
  tagBase?: string;
  thumbnailWidth?: number;
  thumbnailCrop?: boolean;
  thumbnailHeight?: number;
  mediumWidth?: number;
  mediumHeight?: number;
  largeWidth?: number;
  largeHeight?: number;
  uploadsYearMonth?: boolean;
  privacyPageId?: number | null;
};
export type NavigationItem = {
  id: string;
  label: string;
  url: string;
  parentId?: string | null;
  target?: "_self" | "_blank";
};
export type NavigationMenu = {
  id: number;
  name: string;
  location: string;
  items: NavigationItem[];
  updatedAt: string;
};
export type SiteStyle = {
  backgroundColor: string;
  textColor: string;
  accentColor: string;
  fontFamily: string;
  contentWidth: number;
  headingFont: string;
  spacing: number;
};
export type SiteTemplate = {
  id: number;
  slug: string;
  title: string;
  type: "template" | "template-part" | "pattern";
  area?: "uncategorized" | "header" | "footer" | "navigation-overlay";
  content: string;
  rawContent?: string;
  permalink?: string;
  blocks: SerializedBlock[] | null;
  updatedAt: string;
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, {
    ...options,
    headers,
    credentials: "same-origin",
  });
  const data = await response
    .json()
    .catch(() => ({ error: "The server returned an invalid response." }));
  if (!response.ok)
    throw new ApiError(
      data.error || `Request failed (${response.status}).`,
      response.status,
      data,
    );
  return data as T;
}
export const json = (method: string, value?: unknown): RequestInit => ({
  method,
  ...(value === undefined ? {} : { body: JSON.stringify(value) }),
});
export const date = (value: string | null | undefined) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "—";
