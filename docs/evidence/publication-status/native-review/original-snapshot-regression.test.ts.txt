import test from "./isolated-test.js";
import assert from "node:assert/strict";
import type { Footnote, SerializedBlock } from "../src/api.js";
import { acknowledgedDraftPublication, documentHasUnsentChanges, liveDocumentSnapshot, type DraftPublicationAcknowledgement } from "../src/editor/documentSnapshot.js";

const blocks = [{ name: "core/paragraph", attributes: {}, innerHTML: "<p>Saved body.</p>", innerBlocks: [] }];
const current = () => ({ title: "Saved title", content: "<p>Saved body.</p>", blocks: null as SerializedBlock[] | null, footnotes: [] as Footnote[],
  status: "draft", savedStatus: "draft", postDate: "2031-01-02T03:04:19", postDateOriginal: "2031-01-02T03:04:19", postDateGmt: "2031-01-02T11:04:19.000Z", postDateIntent: undefined as string | null | undefined });
const canvas = () => ({ getHTML: () => "<p>Saved body.</p>", getBlocks: () => structuredClone(blocks), getFootnotes: () => [] });

test("a loaded raw-HTML document compares the same live parsed canvas at submission and response", () => {
  const cached = current(), editor = canvas(), submitted = liveDocumentSnapshot(cached, editor);
  assert.equal(cached.blocks, null);
  assert.equal(submitted.blocks?.length, 1);
  assert.equal(documentHasUnsentChanges(cached, submitted, editor), false);
});

test("a newer live body remains dirty even before the cached document receives its editor callback", () => {
  const editor = canvas(), submitted = liveDocumentSnapshot(current(), editor);
  const cached = structuredClone(submitted);
  assert.equal(documentHasUnsentChanges(cached, submitted, { ...editor, getHTML: () => "<p>New unsaved body.</p>" }), true);
});

test("new title, date intent, selected GMT, saved provenance and footnotes are never ignored", () => {
  const editor = canvas(), submitted = liveDocumentSnapshot(current(), editor);
  for (const patch of [{ title: "New unsaved title" }, { postDate: "2032-03-04T05:06:37", postDateIntent: "2032-03-04T05:06:37" },
    { postDateIntent: null }, { postDateGmt: null }, { savedStatus: "future" }, { status: "pending" }]) {
    assert.equal(documentHasUnsentChanges({ ...submitted, ...patch }, submitted, editor), true);
  }
  assert.equal(documentHasUnsentChanges(submitted, submitted, { ...editor, getFootnotes: () => [{ id: "native-note", content: "New unsaved note" }] }), true);
});

test("a missing canvas compares all cached document fields without fabricating content", () => {
  const submitted = current();
  assert.equal(documentHasUnsentChanges(structuredClone(submitted), submitted, null), false);
  assert.equal(documentHasUnsentChanges({ ...submitted, title: "New title" }, submitted, null), true);
});

test("reading a live snapshot changes neither the cached document nor the submitted snapshot", () => {
  const cached = current(), original = structuredClone(cached), editor = canvas();
  const submitted = liveDocumentSnapshot(cached, editor), sent = structuredClone(submitted);
  documentHasUnsentChanges(cached, submitted, editor);
  assert.deepEqual(cached, original);
  assert.deepEqual(submitted, sent);
});

const created: DraftPublicationAcknowledgement["post"] = { status: "draft", postDate: "2031-01-01T00:00:19", postDateGmt: null, scheduledAt: null };
const floating = () => ({ ...current(), postDate: "", postDateOriginal: "", postDateGmt: null, scheduledAt: "" });

test("a new floating draft rebases only its known creation acknowledgement before comparison", () => {
  const editor = canvas(), submitted = liveDocumentSnapshot(floating(), editor), creation = { from: submitted, post: created };
  const acknowledged = { ...submitted, ...acknowledgedDraftPublication(submitted, creation) };
  assert.equal(documentHasUnsentChanges(acknowledged, submitted, editor, creation), false);
  assert.equal(documentHasUnsentChanges(acknowledged, submitted, editor), true, "date/provenance differences are not globally ignored");
});

test("a date selected before Save while automatic creation is pending remains part of the submitted baseline", () => {
  const editor = canvas(), from = floating(), submitted = liveDocumentSnapshot({ ...from, postDate: "2032-03-04T05:06:37", postDateIntent: "2032-03-04T05:06:37" }, editor);
  const creation = { from, post: created }, acknowledged = { ...submitted, ...acknowledgedDraftPublication(submitted, creation) };
  assert.equal(acknowledged.postDate, submitted.postDate);
  assert.equal(acknowledged.postDateIntent, submitted.postDateIntent);
  assert.equal(documentHasUnsentChanges(acknowledged, submitted, editor, creation), false);
});

test("new date, title and status edits made after Save while creation waits remain dirty", () => {
  const editor = canvas(), from = floating(), submitted = liveDocumentSnapshot({ ...from, postDate: "2032-03-04T05:06:37", postDateIntent: "2032-03-04T05:06:37" }, editor);
  const creation = { from, post: created };
  for (const patch of [{ postDate: "2033-04-05T06:07:19", postDateIntent: "2033-04-05T06:07:19" }, { title: "Newer unsaved title" }, { status: "pending" }]) {
    const newer = { ...submitted, ...patch }, acknowledged = { ...newer, ...acknowledgedDraftPublication(newer, creation) };
    assert.equal(documentHasUnsentChanges(acknowledged, submitted, editor, creation), true);
  }
});

test("clearing and later selecting a new date stay distinct across creation acknowledgement", () => {
  const editor = canvas(), submitted = liveDocumentSnapshot({ ...floating(), postDateIntent: null }, editor), creation = { from: floating(), post: created };
  const newer = { ...submitted, postDate: "2033-04-05T06:07:19", postDateIntent: "2033-04-05T06:07:19" };
  assert.equal(documentHasUnsentChanges({ ...newer, ...acknowledgedDraftPublication(newer, creation) }, submitted, editor, creation), true);
});

test("known draft acknowledgement does not mutate the sent values or replace editable content and status", () => {
  const submitted = { ...floating(), status: "pending", title: "Typed title" }, before = structuredClone(submitted);
  const acknowledged = { ...submitted, ...acknowledgedDraftPublication(submitted, { from: submitted, post: created }) };
  assert.equal(acknowledged.status, "pending");
  assert.equal(acknowledged.title, "Typed title");
  assert.deepEqual(submitted, before);
});
