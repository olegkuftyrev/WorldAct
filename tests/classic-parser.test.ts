import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseHTML } from "linkedom";

test("lazy Classic parses undelimited HTML beside a Shortcode and serializes both without a missing block", async () => {
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.defineProperty(document, "implementation", { value: { createHTMLDocument: () => parseHTML("<html><body></body></html>").document } });
  Object.assign(globalThis, { window, document, DOMParser: window.DOMParser, Node: window.Node, MutationObserver: window.MutationObserver });
  const blocks = await import("@wordpress/blocks");
  const { RawHTML, createElement } = await import("@wordpress/element");
  const { registerClassicContentHandler } = await import("../src/editor/classic/register.js");
  const require = createRequire(import.meta.url);
  const libraryRoot = path.dirname(require.resolve("@wordpress/block-library/package.json"));
  for (const name of ["freeform", "shortcode"]) {
    const metadata = JSON.parse(await readFile(path.join(libraryRoot, "build-module", name, "block.json"), "utf8"));
    blocks.registerBlockType(metadata, {
      save: ({ attributes }: any) => createElement(RawHTML, null, name === "freeform" ? attributes.content : attributes.text),
    });
  }
  blocks.registerBlockType("core/missing", { apiVersion: 3, title: "Missing", category: "text", attributes: { originalName: { type: "string" }, originalContent: { type: "string" } }, save: () => null });
  blocks.setUnregisteredTypeHandlerName("core/missing");
  assert.equal((window as any).wp?.oldEditor, undefined, "the legacy runtime stays unloaded");
  registerClassicContentHandler();

  const before = '<h2>Imported Classic</h2>\n<p><strong>Bold</strong> &amp; <em>rich</em> <a href="/example/">link</a>.</p>';
  const shortcode = '[gallery ids="4,9" columns="2"]';
  const after = '<p>Classic after the block.</p>';
  const source = before + "\n\n<!-- wp:shortcode -->\n" + shortcode + "\n<!-- /wp:shortcode -->\n\n" + after;
  const parsed = blocks.parse(source);
  assert.deepEqual(parsed.map(block => block.name), ["core/freeform", "core/shortcode", "core/freeform"]);
  assert.equal(parsed[0].attributes.content, before);
  assert.equal(parsed[1].attributes.text, shortcode);
  assert.equal(parsed[2].attributes.content, after);
  parsed[0].attributes.content += "<p>Native edit retained.</p>";
  const canonical = blocks.serialize(parsed);
  assert.doesNotMatch(canonical, /wp:(?:missing|freeform)/, "Classic keeps the source undelimited serialization");
  const reloaded = blocks.parse(canonical);
  assert.deepEqual(reloaded.map(block => block.name), ["core/freeform", "core/shortcode", "core/freeform"]);
  assert.match(String(reloaded[0].attributes.content), /Native edit retained/);
  assert.equal(reloaded[1].attributes.text, shortcode);
  assert.equal(reloaded[2].attributes.content, after);
  assert.equal((window as any).wp?.oldEditor, undefined);
});
