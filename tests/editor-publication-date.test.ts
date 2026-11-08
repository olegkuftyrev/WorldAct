import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { publicationDateChange, publicationDateInput, publicationDatePayload, publicationInstant } from "../src/editor/publicationDate.js";

test("editor keeps seconds and only changed or explicitly cleared local dates enter the write payload", () => {
  const original = "2026-12-31T23:59:37";
  assert.equal(publicationDateInput("2026-12-31T23:59"), "2026-12-31T23:59:00");
  assert.equal(publicationDateInput(original), original);
  assert.deepEqual(publicationDatePayload(publicationDateChange(original, original).postDateIntent), {});
  assert.deepEqual(publicationDatePayload(publicationDateChange("2027-01-01T00:00:19", original).postDateIntent), { postDate: "2027-01-01T00:00:19" });
  assert.deepEqual(publicationDatePayload(publicationDateChange("", original).postDateIntent), { postDate: null });
  assert.deepEqual(publicationDatePayload(undefined), {}, "unchanged saves preserve the stored GMT even after a zone change");
});

test("schedule hints use the explicit site zone, reject DST gaps and ignore the browser host zone", () => {
  const previous = process.env.TZ;
  try {
    for (const host of ["Pacific/Auckland", "America/New_York", "UTC"]) {
      process.env.TZ = host;
      assert.equal(publicationInstant("2026-12-31T23:59:37", "America/Los_Angeles"), "2027-01-01T07:59:37.000Z");
      assert.equal(publicationInstant("2026-12-31T23:59:37", "+05:45"), "2026-12-31T18:14:37.000Z");
      assert.equal(publicationInstant("2026-03-08T02:30:00", "America/Los_Angeles"), null);
      assert.equal(publicationInstant("2026-02-30T12:00:00", "UTC"), null);
      assert.equal(publicationInstant("0000-01-01T00:00:00", "UTC"), null);
      assert.equal(publicationInstant("2026-01-01T00:00:00Z", "UTC"), null);
    }
  } finally { previous === undefined ? delete process.env.TZ : process.env.TZ = previous; }
});
