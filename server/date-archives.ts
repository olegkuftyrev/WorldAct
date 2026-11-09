import moment from "moment-timezone";
import { HttpError } from "./utils.js";
import { normalizeFixedTimezone } from "./timezone.js";

export type DateArchive = {
  year: number;
  month?: number;
  day?: number;
  week?: number;
};
const invalid = () => new HttpError(400, "Use a valid archive year, month, day or week.");
const pad = (value: number, length = 2) => String(value).padStart(length, "0");
function scalar(query: Record<string, unknown>, key: string): string | undefined {
  const value = query[key];
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" && typeof value !== "number") throw invalid();
  const text = String(value);
  if (!/^\d{1,8}$/.test(text)) throw invalid();
  return text;
}
function validate(archive: DateArchive): DateArchive {
  if (!Number.isInteger(archive.year) || archive.year < 1 || archive.year > 9999) throw invalid();
  if (archive.month !== undefined && (!Number.isInteger(archive.month) || archive.month < 1 || archive.month > 12)) throw invalid();
  if (archive.day !== undefined) {
    if (!archive.month || !Number.isInteger(archive.day) || archive.day < 1 || archive.day > 31) throw invalid();
    const civil = `${pad(archive.year, 4)}-${pad(archive.month)}-${pad(archive.day)}`;
    if (!moment.utc(civil, "YYYY-MM-DD", true).isValid()) throw invalid();
  }
  if (archive.week !== undefined && (!Number.isInteger(archive.week) || archive.week < 0 || archive.week > 53 || archive.month !== undefined || archive.day !== undefined)) throw invalid();
  return archive;
}
export function parseDateArchiveQuery(query: Record<string, unknown>): DateArchive | null {
  const year = scalar(query, "year"), month = scalar(query, "month"), monthnum = scalar(query, "monthnum"),
    day = scalar(query, "day"), compact = scalar(query, "m"), week = scalar(query, "w");
  if ([year, month, monthnum, day, compact, week].every((value) => value === undefined)) return null;
  if (month !== undefined && monthnum !== undefined && Number(month) !== Number(monthnum)) throw invalid();
  let archive: DateArchive;
  if (compact !== undefined) {
    if (![4, 6, 8].includes(compact.length)) throw invalid();
    archive = {
      year: Number(compact.slice(0, 4)),
      ...(compact.length >= 6 ? { month: Number(compact.slice(4, 6)) } : {}),
      ...(compact.length === 8 ? { day: Number(compact.slice(6, 8)) } : {}),
    };
    if ((year !== undefined && Number(year) !== archive.year) ||
      ((month ?? monthnum) !== undefined && Number(month ?? monthnum) !== archive.month) ||
      (day !== undefined && Number(day) !== archive.day)) throw invalid();
  } else {
    if (year === undefined) throw invalid();
    archive = { year: Number(year), ...((month ?? monthnum) !== undefined ? { month: Number(month ?? monthnum) } : {}), ...(day !== undefined ? { day: Number(day) } : {}) };
  }
  if (week !== undefined) archive.week = Number(week);
  return validate(archive);
}
export function parseDateArchivePath(path: string): DateArchive | null {
  const match = /^\/(\d{4})(?:\/(\d{1,2})(?:\/(\d{1,2}))?)?\/?$/.exec(path.split("?")[0]);
  if (!match) return null;
  try { return validate({ year: Number(match[1]), ...(match[2] ? { month: Number(match[2]) } : {}), ...(match[3] ? { day: Number(match[3]) } : {}) }); }
  catch { return null; }
}
export function dateArchivePath(archive: DateArchive): string {
  validate(archive);
  if (archive.week !== undefined) return `/?m=${pad(archive.year, 4)}&w=${archive.week}`;
  return `/${pad(archive.year, 4)}/${archive.month === undefined ? "" : `${pad(archive.month)}/${archive.day === undefined ? "" : `${pad(archive.day)}/`}`}`;
}
/** Parameters are appended; column/localSQL must be trusted server expressions. */
export function dateArchiveLocalSQL(column: string, args: unknown[], timezone: string): string {
  timezone = normalizeFixedTimezone(timezone);
  args.push(timezone);
  return `timezone($${args.length}::${/^[+-]\d{2}:\d{2}$/.test(timezone) ? "interval" : "text"},${column})`;
}
/** Equivalent to the supplied source's _wp_mysql_week(), including week zero. */
export function dateArchiveWeekSQL(localSQL: string, weekStartsOn = 0): string {
  const start = Number.isInteger(weekStartsOn) && weekStartsOn >= 0 && weekStartsOn <= 6 ? weekStartsOn : 0;
  const date = start > 1 ? `(${localSQL} - interval '${start} days')` : `(${localSQL})`;
  const jan1 = `date_trunc('year',${date})`;
  const day = `(${date}::date-${jan1}::date)`;
  if (start === 1) {
    const weekday = `(extract(isodow from ${jan1})::int-1)`;
    return `(floor((${day}+${weekday}-(CASE WHEN ${weekday}>3 THEN 7 ELSE 0 END))/7.0)::int+1)`;
  }
  return `(floor((${day}-((7-extract(dow from ${jan1})::int)%7))/7.0)::int+1)`;
}
export function dateArchiveBoundsUTC(archive: DateArchive, timezone: string, _weekStartsOn = 0): { start: string; end: string } {
  timezone = normalizeFixedTimezone(timezone);
  validate(archive);
  // Weekly source queries combine YEAR(date) with WEEK(date); for nonstandard
  // week starts that can select disjoint intervals. The SQL helper adds the
  // exact week predicate to these enclosing year bounds.
  const civil = moment.utc(`${pad(archive.year, 4)}-${pad(archive.month ?? 1)}-${pad(archive.day ?? 1)}`, "YYYY-MM-DD", true);
  const next = civil.clone().add(1, archive.day !== undefined ? "day" : archive.month !== undefined ? "month" : "year");
  const zoned = (value: moment.Moment) => {
    const local = value.format(value.year() > 9999 ? "YYYYYY-MM-DD[T]HH:mm:ss" : "YYYY-MM-DD[T]HH:mm:ss");
    const fixed = /^[+-]\d{2}:\d{2}$/.test(timezone);
    const date = fixed
      ? moment.parseZone(local + timezone, moment.ISO_8601, true)
      : moment.tz(local, moment.ISO_8601, true, timezone);
    if (!date.isValid()) throw invalid();
    const wanted = value.year() * 10000 + (value.month() + 1) * 100 + value.date();
    const civilDay = (timestamp: number) => {
      const day = fixed ? moment.utc(timestamp).utcOffset(timezone) : moment.tz(timestamp, timezone);
      return day.year() * 10000 + (day.month() + 1) * 100 + day.date();
    };
    let boundary = date.valueOf();
    // Moment can normalize a wholly skipped civil date backward. Resolve the
    // first actual instant on or after that date; both bounds then coincide.
    // Ordinary and midnight-gap days already satisfy this boundary check.
    if (civilDay(boundary) < wanted || civilDay(boundary - 1) >= wanted) {
      let low = boundary - 2 * 86_400_000, high = boundary + 2 * 86_400_000;
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (civilDay(middle) < wanted) low = middle;
        else high = middle;
      }
      boundary = high;
    }
    return new Date(boundary).toISOString();
  };
  return { start: zoned(civil), end: zoned(next) };
}
export function appendDateArchiveSQL(where: string[], args: unknown[], column: string, archive: DateArchive | null, timezone: string, weekStartsOn = 0): void {
  if (!archive) return;
  const { start, end } = dateArchiveSQLBounds(archive, timezone, weekStartsOn);
  args.push(start, end);
  where.push(`${column}>=$${args.length - 1}::timestamptz AND ${column}<$${args.length}::timestamptz`);
  if (archive.week !== undefined) {
    const local = dateArchiveLocalSQL(column, args, timezone);
    args.push(archive.week);
    where.push(`${dateArchiveWeekSQL(local, weekStartsOn)}=$${args.length}::int`);
  }
}
/** PostgreSQL-safe UTC text, independent of pg's host-local Date serializer. */
export function dateArchiveSQLBounds(archive: DateArchive, timezone: string, weekStartsOn = 0): { start: string; end: string } {
  const bounds = dateArchiveBoundsUTC(archive, timezone, weekStartsOn);
  const sqlDate = (value: string) => {
    const date = new Date(value), year = date.getUTCFullYear();
    return `${pad(year <= 0 ? 1 - year : year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}+00:00${year <= 0 ? " BC" : ""}`;
  };
  return { start: sqlDate(bounds.start), end: sqlDate(bounds.end) };
}
export function dateArchiveTitle(archive: DateArchive, { showPrefix = true }: { showPrefix?: boolean } = {}): string {
  validate(archive);
  const civil = moment.utc(`${pad(archive.year, 4)}-${pad(archive.month ?? 1)}-${pad(archive.day ?? 1)}`, "YYYY-MM-DD", true).locale("en");
  const prefix = archive.day !== undefined ? "Day: " : archive.month !== undefined ? "Month: " : "Year: ";
  const label = civil.format(archive.day !== undefined ? "MMMM D, YYYY" : archive.month !== undefined ? "MMMM YYYY" : "YYYY");
  return (showPrefix ? prefix : "") + label;
}
export function dateArchiveDTO(archive: DateArchive) {
  return { type: "date" as const, ...archive, name: dateArchiveTitle(archive), permalink: dateArchivePath(archive) };
}

/** Stored post civil membership is independent of the current site timezone. */
export function postCivilBounds(archive:DateArchive){
 validate(archive);
 const start=moment.utc(`${pad(archive.year,4)}-${pad(archive.month ?? 1)}-${pad(archive.day ?? 1)}T00:00:00`,"YYYY-MM-DDTHH:mm:ss",true);
 const end=start.clone().add(1,archive.day!==undefined?"day":archive.month!==undefined?"month":"year");
 return {start:start.format("YYYY-MM-DDTHH:mm:ss"),end:end.year()===10000?"10000-01-01T00:00:00":end.format("YYYY-MM-DDTHH:mm:ss")};
}
export function appendPostDateArchiveSQL(where:string[],args:unknown[],column:string,archive:DateArchive|null,_timezone:string,weekStartsOn=0){
 if(!archive)return;
 const bounds=postCivilBounds(archive);args.push(bounds.start,bounds.end);
 where.push(`${column}>=$${args.length-1}::timestamp without time zone AND ${column}<$${args.length}::timestamp without time zone`);
 if(archive.week!==undefined){args.push(archive.week);where.push(`${dateArchiveWeekSQL(column,weekStartsOn)}=$${args.length}::int`);}
}
