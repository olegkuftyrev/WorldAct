/** Keep signed Intl timezone forms compatible with Moment and PostgreSQL intervals. */
export function normalizeFixedTimezone(timezone: string): string {
  if (!/^[+-]/.test(timezone)) return timezone;
  const match = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(timezone);
  if (!match || Number(match[2]) > 23 || Number(match[3] ?? 0) > 59) throw new RangeError("Invalid timezone offset.");
  return `${match[1]}${match[2]}:${match[3] ?? "00"}`;
}
