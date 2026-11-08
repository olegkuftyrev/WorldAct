import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { parseHTML } from "linkedom";
import { pathToFileURL } from "node:url";
import { createRegistry, createReduxStore } from "@wordpress/data";
import { createMediaModalOwner, type MediaModalOptions } from "../src/editor/media/modalOwner.js";
import { nativeAspectRatioPresets } from "../src/editor/media/aspectRatios.js";
import { createOpeningRegistry } from "../src/editor/media/openingRegistry.js";

test("retired opening releases inherited registry subscriptions without touching the parent's data or peers", () => {
  const source = createRegistry();
  const records = createReduxStore("test/image-records", { reducer: (state = 7) => state, selectors: { getId: (state: number) => state } });
  source.register(records);
  let subscriptions = 0;
  const parent = { ...source, subscribe: (...args: Parameters<typeof source.subscribe>) => {
    subscriptions++;
    const stop = source.subscribe(...args);
    return () => { subscriptions--; stop(); };
  } };
  const peer = parent.subscribe(() => {});
  const opening = createOpeningRegistry(parent);
  assert.equal(opening.registry.select(records).getId(), 7, "actual parent entity selectors are inherited");
  const stopRecord = opening.registry.subscribe(() => {}, records);
  assert.equal(subscriptions, 3, "peer, source registry parent listener and inherited record listener");
  stopRecord();
  opening.dispose();
  opening.dispose();
  assert.equal(subscriptions, 1, "only the unrelated peer remains");
  assert.equal(parent.select(records).getId(), 7);
  peer();
  assert.equal(subscriptions, 0);
});

test("the actual native media store is per opening, so a late prior save cannot close image B in the same editor", async () => {
  const require = createRequire(import.meta.url);
  const root = path.dirname(require.resolve("@wordpress/media-editor/package.json"));
  const { store } = await import(pathToFileURL(path.join(root, "build-module/store/index.mjs")).href);
  const parent = createRegistry(), a = createOpeningRegistry(parent), b = createOpeningRegistry(parent);
  const prior = a.registry, next = b.registry;
  prior.register(store); next.register(store);
  (prior.dispatch(store) as any).openMediaEditorModal({ id: 4 });
  (next.dispatch(store) as any).openMediaEditorModal({ id: 9 });
  (prior.dispatch(store) as any).closeMediaEditorModal(); // Previous source onSaved resolves late.
  assert.equal((prior.select(store) as any).isOpen(), false);
  assert.equal((next.select(store) as any).isOpen(), true);
  assert.equal((next.select(store) as any).getId(), 9);
  a.dispose(); b.dispose();
});

test("late source attachment edit cleanup cannot erase a reopened same-image Details draft", async () => {
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.assign(globalThis, { window, document, MutationObserver: window.MutationObserver });
  const { store: coreDataStore } = await import("@wordpress/core-data");
  const parent = createRegistry(), a = createOpeningRegistry(parent), b = createOpeningRegistry(parent);
  const record = { id: 13, title: { raw: "Original", rendered: "Original" } };
  for (const opening of [a, b]) {
    opening.registry.register(coreDataStore);
    opening.registry.dispatch(coreDataStore).addEntities([{ kind: "postType", name: "attachment", baseURL: "/wp/v2/media", rawAttributes: ["title", "caption", "description"] }]);
    await opening.registry.dispatch(coreDataStore).receiveEntityRecords("postType", "attachment", record);
  }
  await b.registry.dispatch(coreDataStore).editEntityRecord("postType", "attachment", 13, { title: "B draft" });
  // Source useSaveMediaEditor runs this after a delayed pixel-copy response.
  a.registry.dispatch(coreDataStore).clearEntityRecordEdits("postType", "attachment", 13);
  const edited = b.registry.select(coreDataStore).getEditedEntityRecord("postType", "attachment", 13) as { title: string };
  assert.equal(edited.title, "B draft");
  assert.equal(b.registry.select(coreDataStore).hasEditsForEntityRecord("postType", "attachment", 13), true);
  assert.equal(a.registry.select(coreDataStore).hasEditsForEntityRecord("postType", "attachment", 13), false);
  a.dispose(); b.dispose();
});

test("native crop presets retain source defaults, explicit theme-only lists and validated ratios", () => {
  assert.equal(nativeAspectRatioPresets(undefined, undefined, undefined), undefined);
  assert.deepEqual(nativeAspectRatioPresets([], [], false), []);
  const defaults = [{ name: "Square", ratio: "1" }, { name: "Wide", ratio: "16/9" }];
  const theme = [{ name: "Portrait", ratio: "3/4" }, { name: "Invalid", ratio: "1/0" }, { name: "Invalid", ratio: "Infinity" }];
  assert.deepEqual(nativeAspectRatioPresets(defaults, theme, true), [
    { label: "Square", value: 1 }, { label: "Wide", value: 16 / 9 }, { label: "Portrait", value: 3 / 4 },
  ]);
  assert.deepEqual(nativeAspectRatioPresets(defaults, theme, false), [{ label: "Portrait", value: 3 / 4 }]);
});

test("native image modal retains exact Undo and closes only its own editor's session", () => {
  let current: MediaModalOptions | null = null;
  let closes = 0;
  const adapter = { open: (options: MediaModalOptions) => { current = options; }, close: () => { closes++; current = null; }, currentUpdate: () => current?.onUpdate };
  const first = createMediaModalOwner(adapter), second = createMediaModalOwner(adapter);
  const updates: number[] = [];
  let undos = 0, ownerCloses = 0;
  const undo = () => undos++;
  first.open({ id: 4, onUpdate: value => updates.push(value.id), onUndo: undo, onClose: () => ownerCloses++ });
  const opened = current! as MediaModalOptions;
  assert.equal(opened.onUndo, undo, "source exact block snapshot Undo is passed through, not replaced by an ID-only fallback");
  opened.onUpdate!({ id: 9, url: "/edited.jpg" });
  opened.onUndo!();
  assert.deepEqual(updates, [9]);
  assert.equal(undos, 1);
  second.open({ id: 12 });
  const peer = current! as MediaModalOptions;
  first.dispose();
  assert.equal(closes, 0, "retiring a parent editor does not dismiss its nested editor's active modal");
  assert.equal(current, peer);
  assert.equal(ownerCloses, 0);
  opened.onUpdate!({ id: 99 });
  assert.deepEqual(updates, [9], "an old asynchronous save cannot update a retired editor");
  second.dispose();
  assert.equal(closes, 1);
  assert.equal(current, null);
});

test("cancel and repeated native modal teardown run the owning close callback once", () => {
  let current: MediaModalOptions | null = null;
  let commits = 0, closes = 0;
  const owner = createMediaModalOwner({ open: options => { current = options; }, close: () => { current = null; }, currentUpdate: () => current?.onUpdate });
  owner.open({ id: 3, onUpdate: () => commits++, onClose: () => closes++ });
  owner.dispose();
  owner.dispose();
  assert.equal(commits, 0);
  assert.equal(closes, 1);
  owner.open({ id: 4, onClose: () => closes++ });
  const opened = current! as MediaModalOptions;
  current = null; // Native modal closes its source store before onClose.
  opened.onClose!();
  owner.dispose();
  assert.equal(closes, 2);
});
