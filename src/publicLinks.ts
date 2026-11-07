import type { Post } from "./api";

export function postLink(
  post: Pick<Post, "type" | "slug" | "permalink">,
): string {
  if (post.permalink) {
    try {
      const url = new URL(post.permalink, window.location.origin);
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      /* Fall back to the permanent legacy URL for malformed imported data. */
    }
  }
  return `/${post.type === "page" ? "pages" : "posts"}/${encodeURIComponent(post.slug)}`;
}
