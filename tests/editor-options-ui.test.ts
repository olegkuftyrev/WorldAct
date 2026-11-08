import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { EditorPreferenceQueue, preferencePatch, type PreferenceSnapshot } from "../src/editor/preferenceQueue.js";
import { DEFAULT_EDITOR_PREFERENCES as defaults } from "../shared/editor-preferences.js";
import { editorShortcut } from "../src/editor/editorShortcuts.js";
import { parseHTML } from "linkedom";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
test("private preference writes survive delayed initialization, serialize and rebase newer intent after failure", async () => {
  const load = deferred<unknown>(), first = deferred<unknown>(), second = deferred<unknown>();
  const calls: unknown[] = [], snapshots: PreferenceSnapshot[] = [];
  const queue = new EditorPreferenceQueue(() => load.promise, patch => { calls.push(patch); return calls.length === 1 ? first.promise : second.promise; }, snapshot => snapshots.push(snapshot));
  void queue.start(); queue.update({ focusMode: true }, "/admin/posts/1"); queue.update({ showIconLabels: true }, "/admin/posts/2");
  assert.equal(queue.snapshot().value.focusMode, true); assert.equal(calls.length, 0);
  load.resolve({ fullscreenMode: false, focusMode: false }); await tick();
  assert.equal(calls.length, 1); assert.equal(queue.snapshot().value.focusMode, true); assert.equal(queue.snapshot().value.fullscreenMode, false);
  first.reject(new Error("Permission expired")); await tick();
  assert.equal(calls.length, 2); assert.equal(queue.snapshot().value.focusMode, false); assert.equal(queue.snapshot().value.showIconLabels, true); assert.equal(queue.snapshot().errorScope, "/admin/posts/1");
  second.resolve({ fullscreenMode: false, showIconLabels: true }); await tick();
  assert.equal(queue.snapshot().saving, false); assert.equal(queue.snapshot().value.showIconLabels, true); assert.equal(queue.snapshot().value.focusMode, false);
  assert.ok(snapshots.length > 3);
});
test("retired account queues cannot publish or send unsent operations with a later session", async () => {
  const first = deferred<unknown>(), sent: unknown[] = [], states: unknown[] = [];
  const queue = new EditorPreferenceQueue(async () => ({}), patch => { sent.push(patch); return first.promise; }, state => states.push(state));
  await queue.start(); queue.update({ editorMode: "text" }, "a"); queue.update({ focusMode: true }, "a"); const before = states.length;
  queue.dispose(); first.resolve({ editorMode: "text" }); await tick();
  assert.equal(sent.length, 1); assert.equal(states.length, before);
  const replacement = new EditorPreferenceQueue(async () => ({}), async () => ({}), () => {}); await replacement.start(); assert.deepEqual(replacement.snapshot().value, defaults);
});
test("source distraction settings and platform shortcuts preserve their actual modifier boundaries", () => {
  assert.deepEqual(preferencePatch(defaults, { distractionFree: true }), { distractionFree: true, fixedToolbar: true });
  assert.deepEqual(preferencePatch({ ...defaults, distractionFree: true, fixedToolbar: true }, { distractionFree: false }), { distractionFree: false, fixedToolbar: false });
  assert.deepEqual(preferencePatch(defaults, { fixedToolbar: true }), { fixedToolbar: true, distractionFree: false });
  const event = { key: "m", code: "KeyM", metaKey: true, ctrlKey: false, shiftKey: true, altKey: true, repeat: false, isComposing: false, defaultPrevented: false };
  assert.equal(editorShortcut(event, true), "mode"); assert.equal(editorShortcut(event, false), null);
  assert.equal(editorShortcut({ ...event, key: "µ" }, true), "mode", "Option-modified Mac letters still use the source physical key");
  for (const patch of [{ repeat: true }, { isComposing: true }, { defaultPrevented: true }, { shiftKey: false }]) assert.equal(editorShortcut({ ...event, ...patch }, true), null);
  assert.equal(editorShortcut({ ...event, key: "|", code: "Backslash", altKey: false }, true), "distraction");
  assert.equal(editorShortcut({ ...event, key: "h", metaKey: false, ctrlKey: true, shiftKey: false }, true), "help");
});
test("canonical native parsing preserves invalid recovery, unknown and Classic source while filtering local attributes", async () => {
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.defineProperty(document, "implementation", { value: { createHTMLDocument: () => parseHTML("<html><body></body></html>").document } });
  Object.assign(globalThis, { window, document, DOMParser: window.DOMParser, Node: window.Node, MutationObserver: window.MutationObserver });
  const blocks = await import("@wordpress/blocks"), { createElement, RawHTML } = await import("@wordpress/element");
  blocks.registerBlockType("core/paragraph", { apiVersion: 3, title: "Paragraph", category: "text", attributes: { content: { type: "string", source: "html", selector: "p" }, transient: { type: "string", role: "local" } }, save: ({ attributes }: any) => createElement("p", null, createElement(RawHTML, null, attributes.content)) });
  blocks.registerBlockType("core/freeform", { apiVersion: 3, title: "Classic", category: "text", attributes: { content: { type: "string", source: "html" } }, save: ({ attributes }: any) => createElement(RawHTML, null, attributes.content) });
  blocks.registerBlockType("core/missing", { apiVersion: 3, title: "Missing", category: "text", attributes: { originalName: { type: "string" }, originalContent: { type: "string" } }, save: ({ attributes }: any) => createElement(RawHTML, null, attributes.originalContent) });
  blocks.setUnregisteredTypeHandlerName("core/missing"); blocks.setFreeformContentHandlerName("core/freeform");
  const { parseEditorSource } = await import("../src/editor/editorSource.js");
  const invalid = '<!-- wp:paragraph -->\n<div>Invalid but retained</div>\n<!-- /wp:paragraph -->';
  const unknown = '<!-- wp:example/unavailable {"literal":"<quoted>"} -->\n<aside>Unknown inner HTML</aside>\n<!-- /wp:example/unavailable -->';
  const classic = '<p>Undelimited <strong>Classic</strong>.</p>';
  const parsed = parseEditorSource(invalid + '\n\n' + unknown + '\n\n' + classic);
  assert.equal(parsed[0].isValid, false); assert.equal(parsed[0].originalContent, '<div>Invalid but retained</div>'); assert.ok(parsed[0].clientId);
  assert.equal(parsed[1].name, 'core/missing'); assert.match(String(parsed[1].attributes.originalContent), /Unknown inner HTML/); assert.equal(parsed[2].name, 'core/freeform');
  const serialized = blocks.serialize(parsed); assert.match(serialized, /<div>Invalid but retained<\/div>/); assert.match(serialized, /wp:example\/unavailable/); assert.match(serialized, /Unknown inner HTML/); assert.match(serialized, /Undelimited <strong>Classic/);
});
