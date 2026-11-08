import { date as formatDate } from "@wordpress/date";
import type { PostStatus } from "./api";

/** Source column_date uses the chosen post date in the site's clock, including
 * drafts and Trash. The list response already supplies that effective date. */
export function postListDate(value: string | null | undefined, timezone: string | undefined, status: PostStatus, now = Date.now()) {
  const timestamp = value ? Date.parse(value) : NaN;
  const missed = status === "future" && Number.isFinite(timestamp) && timestamp < now;
  const label = status === "publish" ? "Published" : status === "future" ? missed ? "Missed schedule" : "Scheduled" : "Last Modified";
  let text = "—";
  if (value && timezone && Number.isFinite(timestamp)) {
    try { text = `${formatDate("Y/m/d", value, timezone)} at ${formatDate("g:i a", value, timezone)}`; }
    catch { /* Missing/unusable metadata must not become a browser-local date. */ }
  }
  return { label, text, missed };
}

export function postListMonthLabel(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) === 0) return "";
  return `${formatDate("F", value + "-01T00:00:00Z", "UTC")} ${Number(value.slice(0, 4))}`;
}
