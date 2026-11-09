import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { publicationActionInstant, publicationDateChange, publicationDateInput, publicationDatePayload, publicationInstant } from "../src/editor/publicationDate.js";

test("editor keeps seconds and only changed or explicitly cleared local dates enter the write payload", () => {
  const original = "2026-12-31T23:59:37";
  assert.equal(publicationDateInput("2026-12-31T23:59"), "2026-12-31T23:59:00");
  assert.equal(publicationDateInput(original), original);
  assert.deepEqual(publicationDatePayload(publicationDateChange(original, original).postDateIntent), {});
  assert.deepEqual(publicationDatePayload(publicationDateChange("2027-01-01T00:00:19", original).postDateIntent), { postDate: "2027-01-01T00:00:19" });
  assert.deepEqual(publicationDatePayload(publicationDateChange("", original).postDateIntent), { postDate: null });
  assert.deepEqual(publicationDatePayload(undefined), {}, "unchanged saves preserve the stored GMT even after a zone change");
});

test("reloaded fixed drafts schedule the selected GMT, including seconds and a changed site zone", () => {
  const fixedDraft = {
    postDate: "2100-01-02T03:04:05",
    postDateGmt: "2100-01-02T11:04:05.123Z",
    scheduledAt: null,
  };
  for (const timezone of ["America/Los_Angeles", "+05:45", "Pacific/Auckland", undefined]) {
    assert.equal(publicationActionInstant(fixedDraft, timezone), fixedDraft.postDateGmt);
    assert.deepEqual(publicationDatePayload(undefined), {});
  }
  const staleLegacyDue = { ...fixedDraft, scheduledAt: "2100-01-01T00:00:00.000Z" };
  assert.equal(publicationActionInstant(staleLegacyDue, "UTC"), fixedDraft.postDateGmt,
    "the selected publication instant takes priority over stale legacy schedule metadata");
});

test("only edited civil fields derive a new instant; clearing discards the old selected and legacy due instants", () => {
  const fixedDraft = { postDate: "2100-01-02T03:04:05", postDateGmt: "2100-01-02T11:04:05.000Z", scheduledAt: "2100-01-02T11:04:05.000Z" };
  const edited = { ...fixedDraft, ...publicationDateChange("2100-01-03T04:05:19", fixedDraft.postDate) };
  assert.equal(publicationActionInstant(edited, "+05:45"), "2100-01-02T22:20:19.000Z");
  assert.equal(publicationActionInstant(edited, "America/Los_Angeles"), "2100-01-03T12:05:19.000Z");
  assert.equal(publicationActionInstant(edited), null, "an edited date awaits an explicit site zone");
  assert.equal(publicationActionInstant({ ...fixedDraft, ...publicationDateChange("", fixedDraft.postDate) }, "UTC"), null);
  assert.equal(publicationActionInstant({ ...fixedDraft, ...publicationDateChange(fixedDraft.postDate, fixedDraft.postDate) }, "+05:45"), fixedDraft.postDateGmt,
    "returning to the saved local value returns to the persisted selected instant");
});

test("floating draft publication stays immediate after zone changes, including stale legacy due metadata", () => {
  const floatingDraft = { postDate: "2100-01-02T03:04:05", postDateGmt: null, scheduledAt: "2100-01-02T11:04:05.000Z" };
  for (const timezone of ["America/Los_Angeles", "+05:45", "UTC"]) {
    assert.equal(publicationActionInstant(floatingDraft, timezone), null,
      "a null selected GMT cannot reinterpret old floating civil fields as a future selection");
  }
  const deliberatelyFixed = { ...floatingDraft, ...publicationDateChange("2100-01-02T03:04:19", floatingDraft.postDate) };
  assert.equal(publicationActionInstant(deliberatelyFixed, "+05:45"), "2100-01-01T21:19:19.000Z");
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
