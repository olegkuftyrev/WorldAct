import moment from "moment-timezone";
import { HttpError } from "./utils.js";
import { normalizeFixedTimezone } from "./timezone.js";

const fixedOffset = (timezone: string) => /^[+-]\d{2}:\d{2}$/.test(timezone);

/** WordPress REST's `date` is a local civil time, while `date_gmt` is UTC. */
export function restLocalDate(value: string | Date, timezone: string) {
  timezone = normalizeFixedTimezone(timezone);
  const date = moment(value);
  if (!date.isValid()) throw new HttpError(400, "The publication date is invalid.");
  const localized = fixedOffset(timezone)
    ? date.utcOffset(timezone)
    : date.tz(timezone);
  return localized.format("YYYY-MM-DDTHH:mm:ss");
}

export function restDateToUTC(value: string, timezone: string, gmt = false) {
  timezone = normalizeFixedTimezone(timezone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.test(value))
    throw new HttpError(400, "Use an ISO publication date.");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const date = gmt || hasZone
    ? moment.parseZone(hasZone ? value : value + "Z", moment.ISO_8601, true)
    : fixedOffset(timezone)
      ? moment.parseZone(value + timezone, moment.ISO_8601, true)
      : moment.tz(value, moment.ISO_8601, true, timezone);
  if (!date.isValid()) throw new HttpError(400, "The publication date is invalid.");
  // An absent hour during a daylight-saving transition must not silently shift a schedule.
  if (
    !gmt && !hasZone &&
    restLocalDate(date.toISOString(), timezone).slice(0, 16) !== value.slice(0, 16)
  )
    throw new HttpError(400, "This local time does not exist in the selected timezone. Choose another time or include an explicit UTC offset.");
  return date.toISOString();
}
