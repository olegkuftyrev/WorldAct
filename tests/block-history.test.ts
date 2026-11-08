import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { recordBlockHistory, type BlockHistory } from "../src/editor/blockHistory.js";

test("Classic conversion is one user undo level and redo retains non-persistent Gallery image hydration", () => {
  const classic = [{ name: "core/freeform", content: '[gallery ids="4,9"]' }, { name: "core/shortcode", text: "[audio]" }];
  const converted = [{ name: "core/gallery", images: [{ id: 4 }, { id: 9 }] }, classic[1]];
  const hydrated = [{ name: "core/gallery", images: [{ id: 4, url: "/4.jpg" }, { id: 9, url: "/9.jpg" }] }, classic[1]];
  const history: BlockHistory<unknown> = { items: [classic], index: 0, lastInput: 0 };
  recordBlockHistory(history, converted, "change", 1000);
  recordBlockHistory(history, hydrated, "merge", 3000);
  assert.equal(history.items.length, 2, "a late attachment response adds no undo level");
  history.index--;
  assert.deepEqual(history.items[history.index], classic, "one Undo returns the original Classic and Shortcode");
  history.index++;
  assert.deepEqual(history.items[history.index], hydrated, "Redo returns real image URLs, never upload placeholders");
});

test("native typing merges after its first persistent edit while new edits, ignored derivations and abandoned redo stay separate", () => {
  const history = { items: [""], index: 0, lastInput: 0 };
  recordBlockHistory(history, "H", "change", 1000);
  recordBlockHistory(history, "Hello", "merge", 5000);
  assert.deepEqual(history.items, ["", "Hello"]);
  recordBlockHistory(history, "Hello\nNew paragraph", "change", 6000);
  recordBlockHistory(history, "ignored derived view", "ignore", 7000);
  assert.deepEqual(history.items, ["", "Hello", "Hello\nNew paragraph"]);
  history.index--;
  recordBlockHistory(history, "Alternate typing", "change", 8000);
  assert.deepEqual(history.items, ["", "Hello", "Alternate typing"]);
  recordBlockHistory(history, "Recovered metadata", "input", 9000);
  recordBlockHistory(history, "Recovered metadata edited", "input", 9100);
  assert.equal(history.items.at(-1), "Recovered metadata edited");
  assert.equal(history.items.length, 4);
});
