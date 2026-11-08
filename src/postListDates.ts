import { date as formatDate } from "@wordpress/date";
import type { PostStatus } from "./api";
import { formatPostCivil, parsePostCivil } from "../shared/post-civil-date";

/** Source column_date uses the chosen post date in the site's clock, including
 * drafts and Trash. The list response already supplies that effective date. */
export function postListDate(value: string | null | undefined, timezone: string | undefined, status: PostStatus, now = Date.now(), scheduledAt?: string | null) {
  // A missed schedule is a due-instant policy, independent of the selected civil
  // publication date and any subsequent site timezone change.
  const timestamp = scheduledAt ? Date.parse(scheduledAt) : NaN;
  const missed = status === "future" && Number.isFinite(timestamp) && timestamp < now;
  const label = status === "publish" ? "Published" : status === "future" ? missed ? "Missed schedule" : "Scheduled" : "Last Modified";
  let text = "—";
  if (value && timezone && parsePostCivil(value)) {
    try { text = `${formatPostCivil(value, "Y/m/d", timezone)} at ${formatPostCivil(value, "g:i a", timezone)}`; }
    catch { /* Missing/unusable metadata must not become a browser-local date. */ }
  }
  return { label, text, missed };
}

export function postListMonthLabel(value: string): string {
  if (!/^[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(value) || Number(value.slice(0, 4)) === 0) return "";
  return `${formatDate("F", value + "-01T00:00:00Z", "UTC")} ${Number(value.slice(0, 4))}`;
}
