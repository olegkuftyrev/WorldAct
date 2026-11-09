import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { postListDate, postListMonthLabel } from "../src/postListDates.js";

test("source Date text uses the chosen civil date across site zone changes and signed fractional offsets", () => {
  const zone = "America/Los_Angeles", now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(postListDate("2025-12-31T23:59:00", zone, "publish", now).text, "2025/12/31 at 11:59 pm");
  assert.equal(postListDate("2026-01-01T00:00:00", zone, "publish", now).text, "2026/01/01 at 12:00 am");
  assert.equal(postListDate("2026-06-30T23:59:00", zone, "draft", now).text, "2026/06/30 at 11:59 pm");
  assert.equal(postListDate("2026-07-01T00:00:00", zone, "trash", now).text, "2026/07/01 at 12:00 am");
  assert.equal(postListDate("2026-03-01T00:05:00", "+05:45", "future", now).text, "2026/03/01 at 12:05 am");
  assert.equal(postListDate("2026-02-28T23:00:00", "-05:30", "private", now).text, "2026/02/28 at 11:00 pm");
  for (const changedZone of ["UTC", "+05:45", "Pacific/Auckland"])
    assert.equal(postListDate("2025-12-31T23:59:00", changedZone, "publish", now).text, "2025/12/31 at 11:59 pm");
  assert.equal(postListMonthLabel("2026-06"), "June 2026");
  assert.equal(postListMonthLabel("2026-13"), "");
});

test("source labels and missing metadata do not substitute updated dates or the browser clock", () => {
  const value = "2026-04-01T00:00:00", due = "2026-04-01T00:00:00Z", now = Date.parse(due);
  assert.equal(postListDate(value, "UTC", "publish", now).label, "Published");
  for (const status of ["draft", "pending", "private", "trash"] as const)
    assert.equal(postListDate(value, "UTC", status, now).label, "Last Modified");
  assert.deepEqual(postListDate(value, "UTC", "future", now + 1, due), { label: "Missed schedule", text: "2026/04/01 at 12:00 am", missed: true });
  assert.equal(postListDate(value, "UTC", "future", now, due).label, "Scheduled");
  assert.equal(postListDate(value, "+05:45", "future", now + 1, due).missed, true);
  assert.equal(postListDate(value, "UTC", "future", now + 1).missed, false, "civil text cannot substitute for a UTC due instant");
  assert.equal(postListDate(undefined, "UTC", "draft", now).text, "—");
  assert.equal(postListDate("invalid", "UTC", "draft", now).text, "—");
  assert.equal(postListDate(value, undefined, "draft", now).text, "—");
  const previous = process.env.TZ;
  try { process.env.TZ = "Pacific/Auckland"; assert.equal(postListDate(value, "America/Los_Angeles", "draft", now).text, "2026/04/01 at 12:00 am"); }
  finally { previous === undefined ? delete process.env.TZ : process.env.TZ = previous; }
});
