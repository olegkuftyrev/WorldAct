export type User = {
  id: number;
  username: string;
  email: string;
  displayName: string;
  role: string;
  createdAt: string;
};
export type Post = {
  id: number;
  type: "post" | "page";
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  status: "publish" | "draft" | "trash";
  authorId: number;
  authorName: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
};
export type Media = {
  id: number;
  title: string;
  url: string;
  mimeType: string;
  filename: string;
  alt: string;
  caption: string;
  size: number;
  createdAt: string;
};
export type Comment = {
  id: number;
  authorName: string;
  authorEmail: string;
  content: string;
  status: "approved" | "pending" | "spam" | "trash";
  postId: number;
  postTitle: string;
  createdAt: string;
};
export type Settings = {
  siteTitle: string;
  tagline: string;
  siteUrl: string;
  adminEmail: string;
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  postsPerPage: number;
  discourageSearchEngines: boolean;
  theme: "twentytwentyfive" | "classic";
};
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
    throw new Error(data.error || `Request failed (${response.status}).`);
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
