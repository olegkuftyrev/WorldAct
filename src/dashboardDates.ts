import { date as formatDate } from "@wordpress/date";

type SiteClock = { timezone?: string; timeFormat?: string };

// Source dashboard.php labels site-local calendar days, then uses the site's
// configured time format. Advancing the civil date avoids 23/25-hour DST days.
export function dashboardActivityDate(value: string | null | undefined, settings: SiteClock, now = new Date()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const zone = settings.timezone || "UTC";
  const today = formatDate("Y-m-d", now, zone);
  const [year, month, day] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  const localDay = formatDate("Y-m-d", value, zone);
  const label = localDay === today ? "Today" : localDay === tomorrow ? "Tomorrow" :
    formatDate(localDay.slice(0, 4) === today.slice(0, 4) ? "M jS" : "M jS Y", value, zone);
  return `${label}, ${formatDate(settings.timeFormat || "g:i a", value, zone)}`;
}

export function dashboardDraftDate(value: string, timezone = "UTC"): string {
  return Number.isFinite(Date.parse(value)) ? formatDate("F j, Y", value, timezone) : "";
}
