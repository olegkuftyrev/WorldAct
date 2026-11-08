import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { dashboardActivityDate, dashboardDraftDate } from "../src/dashboardDates.js";

test("dashboard activity uses the site's civil Today/Tomorrow, configured time and source ordinal/year labels", () => {
  const site = { timezone: "America/Los_Angeles", timeFormat: "g:i a" }, now = new Date("2026-11-08T07:30:00Z");
  assert.equal(dashboardActivityDate("2026-11-08T06:00:00Z", site, now), "Today, 10:00 pm");
  assert.equal(dashboardActivityDate("2026-11-08T10:00:00Z", site, now), "Tomorrow, 2:00 am");
  assert.equal(dashboardActivityDate("2026-11-15T16:45:00Z", site, now), "Nov 15th, 8:45 am");
  assert.equal(dashboardActivityDate("2025-12-31T16:45:00Z", site, now), "Dec 31st 2025, 8:45 am");
  assert.equal(dashboardActivityDate("2026-11-08T01:15:00Z", { timezone: "+05:30", timeFormat: "H:i" }, new Date("2026-11-08T00:00:00Z")), "Today, 06:45");
  assert.equal(dashboardActivityDate(null, site, now), "");
  assert.equal(dashboardActivityDate("invalid", site, now), "");
});

test("site-local Tomorrow advances a calendar date across short and long DST days", () => {
  const site = { timezone: "America/Los_Angeles", timeFormat: "H:i" };
  assert.equal(dashboardActivityDate("2026-03-09T08:30:00Z", site, new Date("2026-03-08T08:30:00Z")), "Tomorrow, 01:30");
  assert.equal(dashboardActivityDate("2026-11-02T08:30:00Z", site, new Date("2026-11-01T07:30:00Z")), "Tomorrow, 00:30");
  assert.equal(dashboardDraftDate("2026-11-08T02:00:00Z", "America/Los_Angeles"), "November 7, 2026");
});
