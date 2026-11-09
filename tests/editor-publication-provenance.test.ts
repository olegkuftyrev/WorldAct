import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { publicationAction, publicationActionInstant, publicationDatePayload } from "../src/editor/publicationDate.js";

const legacy = { postDate: "2031-01-02T03:04:19", postDateGmt: null, scheduledAt: "2099-01-01T00:00:00.000Z" };
const now = new Date("2031-01-01T00:00:00.000Z");

test("saved nonfloating rows without selected GMT can submit their unchanged civil date", () => {
  for (const savedStatus of ["publish", "future", "private"]) {
    const saved = { ...legacy, savedStatus };
    assert.equal(publicationActionInstant(saved, "+05:45"), "2031-01-01T21:19:19.000Z");
    assert.deepEqual(publicationAction(saved, "+05:45", now), { status: "future", canSubmitSchedule: true });
    assert.deepEqual(publicationDatePayload(undefined), {}, "the server chooses GMT; the client invents no date payload");
  }
});

test("saved provenance rather than an unsaved status control determines null-GMT fallback", () => {
  const editedControl = { ...legacy, savedStatus: "private", status: "draft" };
  assert.equal(publicationActionInstant(editedControl, "UTC"), "2031-01-02T03:04:19.000Z");
  const returnedDraft = { ...editedControl, savedStatus: "draft", status: "future" };
  assert.equal(publicationActionInstant(returnedDraft, "UTC"), null,
    "a successfully saved draft is floating; an unsaved Scheduled selection cannot restore old provenance");
});

test("new, draft and pending floating rows still require an independent chosen date to schedule", () => {
  for (const savedStatus of [undefined, "draft", "pending"]) {
    const floating = { ...legacy, savedStatus, status: "future" };
    assert.deepEqual(publicationAction(floating, "UTC", now), { status: "publish", canSubmitSchedule: false });
    const chosen = { ...floating, postDateIntent: legacy.postDate };
    assert.equal(publicationActionInstant(chosen, "UTC"), "2031-01-02T03:04:19.000Z");
  }
});

test("selected fixed GMT always wins over civil, saved status, changed site zone and inactive due", () => {
  const fixed = { ...legacy, savedStatus: "future", postDateGmt: "2031-01-02T11:04:19.123Z" };
  for (const zone of ["UTC", "+05:45", "Pacific/Auckland", undefined]) {
    assert.equal(publicationActionInstant(fixed, zone), fixed.postDateGmt);
  }
});

test("explicit clear discards nonfloating provenance while changed dates use the new site zone", () => {
  const saved = { ...legacy, savedStatus: "future" };
  assert.equal(publicationActionInstant({ ...saved, postDate: "", postDateIntent: null }, "UTC"), null);
  assert.deepEqual(publicationDatePayload(null), { postDate: null });
  assert.equal(publicationActionInstant({ ...saved, postDate: "2031-01-03T04:05:19", postDateIntent: "2031-01-03T04:05:19" }, "+05:45"), "2031-01-02T22:20:19.000Z");
});

test("saved null-GMT fallback never normalizes gaps, invalid civil or missing site zones", () => {
  for (const [postDate, zone] of [["2026-03-08T02:30:00", "America/Los_Angeles"], ["2031-02-30T12:00:00", "UTC"], [legacy.postDate, undefined]] as const) {
    const saved = { ...legacy, savedStatus: "future", postDate };
    assert.equal(publicationActionInstant(saved, zone), null);
    assert.equal(publicationAction(saved, zone, now).canSubmitSchedule, false);
  }
});
