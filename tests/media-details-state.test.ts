import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { mergeMediaDetails } from "../src/mediaDetailsState.js";
import type { Media } from "../src/api.js";

const original = { id: 1, title: "Original", alt: "Alternative", caption: "Caption", description: "Description", commentStatus: "open", width: 120, height: 80, url: "/original.png" } as Media & { description: string; commentStatus: "open" | "closed" };

test("committed image pixels refresh without replacing an attachment's unsaved metadata", () => {
  const draft = { ...original, title: "New draft", caption: "New caption" };
  const result = mergeMediaDetails(draft, null, { ...original, width: 80, height: 120, url: "/rotated.png" });
  assert.equal(result?.url, "/rotated.png");
  assert.equal(result?.width, 80);
  assert.equal(result?.title, "New draft");
  assert.equal(result?.caption, "New caption");
  assert.equal(mergeMediaDetails({ ...draft, id: 2 }, null, original)?.id, 2);
  assert.equal(mergeMediaDetails(null, null, original), null);
});

test("metadata completion applies server normalization only to fields not edited again after Submit", () => {
  const submitted = { ...original, title: "Submitted", alt: "Submitted alt" };
  const laterDraft = { ...submitted, title: "Typed while saving", commentStatus: "closed" as const };
  const result = mergeMediaDetails(laterDraft, submitted, { ...submitted, title: "Server title", alt: "Normalized alt", url: "/current.png" });
  assert.equal(result?.title, "Typed while saving");
  assert.equal(result?.alt, "Normalized alt");
  assert.equal(result?.commentStatus, "closed");
  assert.equal(result?.url, "/current.png");
});
