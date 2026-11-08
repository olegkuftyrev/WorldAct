import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { restLocalDate, restDateToUTC } from "../server/date.js";

test("REST civil dates round-trip across site timezones, UTC offsets and daylight-saving changes", () => {
  const timezone = "America/Los_Angeles";
  assert.equal(restLocalDate("2026-11-07T06:14:00Z", timezone), "2026-11-06T22:14:00");
  assert.equal(restDateToUTC("2026-11-06T22:14:00", timezone), "2026-11-07T06:14:00.000Z");
  assert.equal(restDateToUTC("2026-11-06T22:14:00-08:00", timezone), "2026-11-07T06:14:00.000Z");
  assert.equal(restDateToUTC("2026-11-07T06:14:00", timezone, true), "2026-11-07T06:14:00.000Z");
  assert.equal(restDateToUTC("2026-07-01T15:00:00", timezone), "2026-07-01T22:00:00.000Z");
  assert.equal(restLocalDate("2026-11-07T09:00:00Z", "+03:00"), "2026-11-07T12:00:00");
  assert.equal(restDateToUTC("2026-11-07T12:00:00", "+03:00"), "2026-11-07T09:00:00.000Z");
  assert.equal(restLocalDate("2026-11-07T09:00:00Z", "+00:05"), "2026-11-07T09:05:00");
  assert.equal(restDateToUTC("2026-11-07T12:00:00", "-05:30"), "2026-11-07T17:30:00.000Z");
  const repeated = restDateToUTC("2026-11-01T01:30:00", timezone);
  assert.equal(restLocalDate(repeated, timezone), "2026-11-01T01:30:00");
  assert.throws(() => restDateToUTC("2026-03-08T02:30:00", timezone), /does not exist/);
  assert.throws(() => restDateToUTC("2026-02-30T12:00:00", timezone), /invalid/);
});
