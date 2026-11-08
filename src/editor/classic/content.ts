/** Fixed data adapters for the supplied legacy editor; never execute saved text. */
export const escapeClassicHTML = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
export function classicMediaURL(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    !/^(?:https?:\/\/|\/(?!\/))/i.test(value) ||
    /[\u0000-\u0020<>"'\\]/.test(value)
  )
    return "";
  try {
    const url = new URL(value, "https://worldact.invalid/");
    return !url.username && !url.password ? value : "";
  } catch {
    return "";
  }
}
export function classicMediaHTML(item: Record<string, any>): string {
  const url = classicMediaURL(item.url || item.source_url),
    type = String(item.mime || item.mime_type || ""),
    title =
      typeof item.title === "object"
        ? item.title.raw || item.title.rendered
        : item.title;
  if (!url) return "";
  const text = escapeClassicHTML(title || item.filename || "Media"),
    href = escapeClassicHTML(url),
    id = Number.isSafeInteger(item.id) && item.id > 0 ? item.id : 0;
  if (type.startsWith("image/")) {
    const dimension = (name: string) =>
      Number.isSafeInteger(item[name]) && item[name] > 0
        ? ` ${name}="${item[name]}"`
        : "";
    return `<img src="${href}" alt="${escapeClassicHTML(item.alt || item.alt_text || "")}" class="alignnone size-full${id ? ` wp-image-${id}` : ""}"${dimension("width")}${dimension("height")} />`;
  }
  if (type.startsWith("audio/") || type.startsWith("video/")) {
    const tag = type.startsWith("audio/") ? "audio" : "video";
    return `<${tag} controls="controls" preload="none" src="${href}"><a href="${href}">${text}</a></${tag}>`;
  }
  return `<a href="${href}">${text}</a>`;
}
export type LegacyLink = {
  ID: number;
  title: string;
  permalink: string;
  info: string;
};
export async function classicLinkQuery(
  search: unknown,
  page: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<LegacyLink[]> {
  const query = new URLSearchParams({
    search: typeof search === "string" ? search.slice(0, 200) : "",
    page: String(Math.min(1000, Math.max(1, Math.trunc(Number(page)) || 1))),
    per_page: "20",
  });
  const response = await fetcher(`/wp-json/wp/v2/search?${query}`, {
    signal,
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok)
    throw new Error("Links could not be loaded. Try searching again.");
  const rows: unknown = await response.json();
  if (!Array.isArray(rows))
    throw new Error("Links could not be loaded. Try searching again.");
  return rows.slice(0, 20).flatMap((row) =>
    row &&
    Number.isSafeInteger(row.id) &&
    row.id > 0 &&
    classicMediaURL(row.url)
      ? [
          {
            ID: row.id,
            title: escapeClassicHTML(row.title || "(no title)"),
            permalink: row.url,
            info: row.subtype === "page" ? "Page" : "Post",
          },
        ]
      : [],
  );
}
