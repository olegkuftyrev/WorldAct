import { authorArchivePagePath, parseAuthorArchivePath } from "../shared/author-archive";
import type { PublicArchive, PublicSettings } from "../shared/public-document";

/** Only a resolved pretty path owns the author page suffix. Numeric aliases
 * keep query paging even when the site's generated author links are pretty. */
function prettyAuthorBase(path: string, archive: PublicArchive | null | undefined, settings: PublicSettings | undefined) {
  if (!archive || !("type" in archive) || archive.type !== "author" || archive.permalink.includes("?")) return null;
  const parsed = parseAuthorArchivePath(path, { permalinkStructure: settings?.permalinkStructure || "" });
  return parsed && !parsed.invalid ? archive.permalink : null;
}

export function publicArchivePageLocation(path: string, archive: PublicArchive | null | undefined, settings: PublicSettings | undefined, page: number): string {
  const target = new URL(path, "https://worldact.invalid"), base = prettyAuthorBase(path, archive, settings);
  if (base) {
    target.pathname = authorArchivePagePath(base, page);
    target.searchParams.delete("page");
  } else target.searchParams.set("page", String(Math.max(1, page)));
  return target.pathname + target.search;
}

export function publicArchiveSearchPath(path: string, archive: PublicArchive | null | undefined, settings: PublicSettings | undefined): string {
  return prettyAuthorBase(path, archive, settings) || new URL(path, "https://worldact.invalid").pathname;
}
