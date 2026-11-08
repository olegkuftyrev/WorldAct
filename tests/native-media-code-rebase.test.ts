import test, { before } from "./isolated-test.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import type { Block } from "@wordpress/blocks";
import {
  imageAttributes,
  changedImageAttributes,
  rebaseNativeImageSource,
} from "../src/editor/media/sourceRebase.js";
import { recordBlockHistory } from "../src/editor/blockHistory.js";
let parse: typeof import("../src/editor/editorSource.js").parseEditorSource;
before(async () => {
  const { window, document } = parseHTML("<html><body></body></html>");
  Object.defineProperty(document, "implementation", {
    value: {
      createHTMLDocument: () =>
        parseHTML("<html><body></body></html>").document,
    },
  });
  Object.assign(globalThis, {
    window,
    document,
    DOMParser: window.DOMParser,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
  });
  // hpq reads NamedNodeMap properties like a browser. Linkedom only exposes
  // numeric keys, so supply that DOM API shape without changing block parsing.
  const attributes = Object.getOwnPropertyDescriptor(
    window.Element.prototype,
    "attributes",
  )!;
  Object.defineProperty(window.Element.prototype, "attributes", {
    get() {
      const map = attributes.get!.call(this);
      return new Proxy(map, {
        get(target, key) {
          return typeof key === "string"
            ? (Reflect.get(target, key) ?? target.getNamedItem(key))
            : Reflect.get(target, key);
        },
        getOwnPropertyDescriptor(target, key) {
          const item =
            typeof key === "string" ? target.getNamedItem(key) : null;
          return item
            ? {
                value: item,
                configurable: true,
                enumerable: true,
                writable: false,
              }
            : Reflect.getOwnPropertyDescriptor(target, key);
        },
      });
    },
  });
  const { registerBlockType, setUnregisteredTypeHandlerName } = await import(
    "@wordpress/blocks"
  );
  const { createElement, RawHTML } = await import("@wordpress/element");
  const schema = JSON.parse(
    await readFile(
      new URL(
        "../node_modules/@wordpress/block-library/src/image/block.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  registerBlockType("core/image", {
    ...schema,
    save: ({ attributes: a }: any) =>
      createElement(
        RawHTML,
        null,
        `<figure class="wp-block-image${a.sizeSlug ? " size-" + a.sizeSlug : ""}">${a.href ? '<a href="' + a.href + '">' : ""}<img src="${a.url}" alt="${a.alt}" class="wp-image-${a.id}"/>${a.href ? "</a>" : ""}${String(a.caption || "") ? '<figcaption class="wp-element-caption">' + a.caption + "</figcaption>" : ""}</figure>`,
      ),
  });
  registerBlockType("core/group", {
    apiVersion: 3,
    title: "Group",
    attributes: {},
    category: "text",
    save: () => null,
  });
  registerBlockType("core/missing", {
    apiVersion: 3,
    title: "Missing",
    category: "text",
    attributes: {
      originalName: { type: "string" },
      originalContent: { type: "string" },
    },
    save: ({ attributes }: any) =>
      createElement(RawHTML, null, attributes.originalContent),
  });
  setUnregisteredTypeHandlerName("core/missing");
  ({ parseEditorSource: parse } = await import(
    "../src/editor/editorSource.js"
  ));
});
const image = (
  id = 30,
  url = "/uploads/new-225x300.png",
  caption = "Source <em>caption</em> &lt;literal&gt;",
  href = "/uploads/new.png",
  size = "medium",
) =>
  `<!-- wp:image { "id" : ${id}, "sizeSlug" : "${size}", "linkDestination":"media" } -->\n<figure class="wp-block-image size-${size}"><a href="${href}"><img src="${url}" alt="Native alt" class="wp-image-${id}"/></a><figcaption class="wp-element-caption">${caption}</figcaption></figure>\n<!-- /wp:image -->`;
const flat = (blocks: Block[]): Block[] =>
  blocks.flatMap((b) => [b, ...flat(b.innerBlocks || [])]);
const native = (blocks: Block[]) =>
  flat(blocks).filter((b) => b.name === "core/image");
const undo = (block: Block, expected = imageAttributes(block)!) => ({
  clientId: block.clientId,
  expected,
  changes: {
    id: 20,
    url: "/uploads/original-300x225.png",
    href: "/uploads/original.png",
    sizeSlug: "medium",
    caption: "Original <em>caption</em>",
  },
});

test("explicit native Undo splices media into newer raw source, retaining rich authored caption and invalid/unknown neighbors byte for byte", () => {
  const initial = image(),
    old = parse(initial),
    raw =
      '  <!-- wp:example/unavailable { "keep": [1,{"text":"a}b"}] } -->\n<aside data-raw="same">Unknown</aside>\n<!-- /wp:example/unavailable -->\n\n' +
      initial.replace(
        "Source <em>caption</em> &lt;literal&gt;",
        "Newer <strong>authored</strong> &lt;literal&gt;",
      ) +
      '\n\n<!-- wp:image -->\n<div>Invalid Image recovery</div>\n<!-- /wp:image -->\n\n<!-- wp:paragraph -->\n<p>New paragraph <sup data-fn="retained">1</sup></p>\n<!-- /wp:paragraph -->  ';
  const current = parse(raw, old),
    target = native(current).find((b) => b.attributes.id === 30)!;
  assert.equal(target.clientId, old[0].clientId);
  assert.equal(target.isValid, true);
  const result = rebaseNativeImageSource(raw, current, undo(old[0]));
  assert.equal(result.changed, true);
  assert.equal(
    result.source,
    raw
      .replace('"id" : 30', '"id" : 20')
      .replace("/uploads/new-225x300.png", "/uploads/original-300x225.png")
      .replace("/uploads/new.png", "/uploads/original.png")
      .replace("wp-image-30", "wp-image-20"),
  );
  assert.equal(
    String(native(result.blocks)[0].attributes.caption),
    "Newer <strong>authored</strong> &lt;literal&gt;",
  );
  const restored = native(parse(result.source))[0];
  assert.equal(restored.isValid, true);
  assert.equal(restored.attributes.id, 20);
  assert.equal(restored.attributes.url, "/uploads/original-300x225.png");
  assert.equal(native(result.blocks)[1].isValid, false);
  assert.equal(result.blocks[0].clientId, current[0].clientId);
});

test("native owner follows a moved/nested Image; unique same-attachment peers do not steal its notice", () => {
  const first = image(),
    second = image(30, undefined, "Distinct caption"),
    old = parse(first + "\n\n" + second);
  const raw =
    '<!-- wp:group --><div class="wp-block-group">' +
    second +
    "\n\n" +
    first.replace(
      "Source <em>caption</em> &lt;literal&gt;",
      "New owner caption",
    ) +
    "</div><!-- /wp:group -->";
  const current = parse(raw, old),
    items = native(current);
  assert.equal(items[0].clientId, native(old)[1].clientId);
  assert.equal(items[1].clientId, native(old)[0].clientId);
  const result = rebaseNativeImageSource(raw, current, undo(native(old)[0]));
  assert.equal(result.changed, true);
  assert.ok(result.source.includes(second));
  assert.match(result.source, /New owner caption/);
  assert.equal(native(result.blocks)[0].attributes.id, 30);
  assert.equal(native(result.blocks)[1].attributes.id, 20);
});

test("ambiguous duplicates, deleted/replaced owners and invalid affected Image cannot receive stale native Undo", () => {
  const raw = image(),
    old = parse(raw),
    change = undo(old[0]);
  const duplicated = parse(raw + "\n\n" + raw, old);
  assert.ok(native(duplicated).every((b) => b.clientId !== old[0].clientId));
  assert.equal(
    rebaseNativeImageSource(raw + "\n\n" + raw, duplicated, change).changed,
    false,
  );
  const identicalOld = parse(raw + "\n\n" + raw),
    identicalNew = parse(raw + "\n\n" + raw, identicalOld);
  assert.ok(
    native(identicalNew).every(
      (b) => !native(identicalOld).some((o) => o.clientId === b.clientId),
    ),
  );
  for (const next of [
    "",
    image(99, "/replacement.png"),
    raw.replace("<img", "<section").replace("/></a>", "/></section></a>"),
  ]) {
    const current = parse(next, old);
    assert.equal(rebaseNativeImageSource(next, current, change).changed, false);
  }
});

test("source authored href, size, caption and alt win over the native operation baseline", () => {
  const raw = image(),
    old = parse(raw),
    change = {
      ...undo(old[0]),
      changes: { ...undo(old[0]).changes, alt: "Old alt", sizeSlug: "full" },
    };
  const currentRaw = raw
    .replace('"medium"', '"large"')
    .replace("size-medium", "size-large")
    .replace("/uploads/new.png", "/custom-destination")
    .replace("Native alt", "Authored alt")
    .replace("Source <em>caption</em> &lt;literal&gt;", "Authored caption");
  const current = parse(currentRaw, old),
    result = rebaseNativeImageSource(currentRaw, current, change);
  assert.equal(result.changed, true);
  assert.equal(
    result.source,
    currentRaw
      .replace('"id" : 30', '"id" : 20')
      .replace("wp-image-30", "wp-image-20")
      .replace("/uploads/new-225x300.png", "/uploads/original-300x225.png"),
  );
  assert.equal(native(result.blocks)[0].attributes.sizeSlug, "large");
  assert.equal(native(parse(result.source))[0].isValid, true);
});

test("changing derived link ownership to custom protects an identical URL", () => {
  const raw = image(),
    old = parse(raw),
    custom = raw.replace(
      '"linkDestination":"media"',
      '"linkDestination":"custom"',
    );
  const result = rebaseNativeImageSource(
    custom,
    parse(custom, old),
    undo(old[0]),
  );
  assert.equal(result.changed, true);
  assert.ok(result.source.includes('href="/uploads/new.png"'));
  assert.equal(native(result.blocks)[0].attributes.linkDestination, "custom");
});

test("genuine changed-key patches retain unaffected JSON spacing, quotes and inline styles, and source history remains reversible", () => {
  const raw = image()
    .replace('"sizeSlug" : "medium", ', "")
    .replace(" size-medium", "")
    .replace(
      'src="/uploads/new-225x300.png"',
      "src = '/uploads/new-225x300.png'",
    );
  const blocks = parse(raw);
  assert.equal(blocks[0].isValid, true);
  const change = {
    clientId: blocks[0].clientId,
    expected: imageAttributes(blocks[0])!,
    changes: { id: 20, url: "/uploads/original-300x225.png", sizeSlug: "full" },
  };
  const result = rebaseNativeImageSource(raw, blocks, change);
  assert.equal(result.changed, true);
  assert.match(result.source, /src = '\/uploads\/original-300x225.png'/);
  assert.match(result.source, /"sizeSlug":"full"/);
  assert.equal(native(parse(result.source))[0].attributes.sizeSlug, "full");
  const state = { items: [{ source: raw, blocks }], index: 0, lastInput: 0 };
  recordBlockHistory(state, { source: raw + "\n", blocks }, "input", 1000);
  recordBlockHistory(state, result, "change", 1001);
  recordBlockHistory(
    state,
    { source: result.source + "\n\n<p>Typing</p>", blocks: result.blocks },
    "input",
    1002,
  );
  assert.equal(state.items.length, 4);
  assert.equal(state.items[1].source, raw + "\n");
  assert.equal(state.items[2].source, result.source);
  assert.equal(state.items[0].source, raw);
  assert.deepEqual(
    changedImageAttributes(
      { id: 1, caption: "same", url: "/old" },
      { id: 2, caption: "same", url: "/new" },
    ),
    { id: 2, url: "/new" },
  );
});
