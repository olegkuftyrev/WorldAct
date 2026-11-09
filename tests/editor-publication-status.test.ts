import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { publicationAction, publicationDateChange, publicationDatePayload } from "../src/editor/publicationDate.js";

const fixed = (postDateGmt: string) => ({ postDate: "2031-01-02T03:04:05", postDateGmt });

test("editor Publish and Schedule hints share the whole-second sixty boundary", () => {
  const now = new Date("2031-01-01T00:00:00.999Z");
  for (const [selected, status] of [
    ["2031-01-01T00:00:59.999Z", "publish"],
    ["2031-01-01T00:01:00.000Z", "future"],
    ["2030-12-31T23:59:59.999Z", "publish"],
  ] as const) {
    assert.equal(publicationAction(fixed(selected), "Pacific/Auckland", now).status, status);
  }
});

test("valid saved schedules remain submittable after entering the minute window or passing due", () => {
  const saved = fixed("2031-01-01T00:01:00.000Z");
  for (const now of ["2031-01-01T00:00:01.000Z", "2031-01-01T00:01:00.000Z", "2031-01-01T00:02:00.000Z"]) {
    assert.deepEqual(publicationAction(saved, "UTC", new Date(now)), { status: "publish", canSubmitSchedule: true });
    assert.deepEqual(publicationDatePayload(undefined), {}, "the late save does not rewrite the chosen pair");
  }
});

test("a loaded chosen schedule that is now past due can reach the authoritative save", () => {
  assert.equal(publicationAction(fixed("2031-01-01T00:01:00.000Z"), "UTC", new Date("2031-01-01T00:02:00.000Z")).canSubmitSchedule, true);
});

test("fixed draft hints retain selected GMT through site-zone changes and inactive legacy due dates", () => {
  const saved = { ...fixed("2031-01-01T00:02:19.123Z"), scheduledAt: "2001-01-01T00:00:00.000Z" };
  for (const zone of ["America/Los_Angeles", "+05:45", "UTC", undefined]) {
    assert.deepEqual(publicationAction(saved, zone, new Date("2031-01-01T00:01:19.999Z")), { status: "future", canSubmitSchedule: true });
  }
});

test("changed civil dates use the current explicit zone with seconds retained", () => {
  const saved = fixed("2031-01-02T03:04:05.000Z");
  const edited = { ...saved, ...publicationDateChange("2031-01-01T05:46:19", saved.postDate) };
  const now = new Date("2031-01-01T00:00:20.999Z");
  assert.deepEqual(publicationAction(edited, "+05:45", now), { status: "publish", canSubmitSchedule: true });
  assert.deepEqual(publicationAction(edited, "UTC", now), { status: "future", canSubmitSchedule: true });
  assert.deepEqual(publicationDatePayload(edited.postDateIntent), { postDate: "2031-01-01T05:46:19" });
});

test("floating and explicitly cleared drafts publish immediately without resurrecting stale due metadata", () => {
  const now = new Date("2031-01-01T00:00:00.000Z");
  const saved = { ...fixed("2099-01-01T00:00:00.000Z"), scheduledAt: "2099-01-01T00:00:00.000Z" };
  for (const zone of ["Pacific/Auckland", "+05:45", "UTC"]) {
    for (const value of [{ ...saved, postDateGmt: null }, { ...saved, ...publicationDateChange("", saved.postDate) }]) {
      assert.deepEqual(publicationAction(value, zone, now), { status: "publish", canSubmitSchedule: false });
    }
  }
  assert.deepEqual(publicationDatePayload(null), { postDate: null });
});

test("missing zones, invalid civil fields and DST gaps cannot submit a schedule", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  for (const [postDate, zone] of [["2026-03-08T02:30:00", "America/Los_Angeles"], ["2026-02-30T12:00:00", "UTC"], ["2031-01-01T00:00:00", undefined]] as const) {
    assert.equal(publicationAction({ postDate, postDateGmt: null, postDateIntent: postDate }, zone, now).canSubmitSchedule, false);
  }
});
