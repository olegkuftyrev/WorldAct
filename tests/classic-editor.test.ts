import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import {
  classicLinkQuery,
  classicMediaHTML,
  classicMediaURL,
} from "../src/editor/classic/content.js";
import {
  classicState,
  wrapClassicLifecycle,
  type ClassicWindow,
} from "../src/editor/classic/lifecycle.js";

test("Classic media uses escaped real media HTML and never treats absent or unsafe URLs as content", () => {
  assert.equal(classicMediaURL(""), "");
  assert.equal(classicMediaURL("//evil.test/a"), "");
  assert.equal(
    classicMediaHTML({ url: "javascript:alert(1)", mime: "image/png" }),
    "",
  );
  const image = classicMediaHTML({
    id: 7,
    url: "/uploads/photo.png?a=1&b=2",
    title: "Photo",
    alt: 'A "quoted" <caption>',
    mime: "image/png",
    width: 640,
    height: 480,
  });
  assert.match(image, /src="\/uploads\/photo.png\?a=1&amp;b=2"/);
  assert.match(image, /alt="A &quot;quoted&quot; &lt;caption&gt;"/);
  assert.match(image, /wp-image-7/);
  assert.match(image, /width="640" height="480"/);
  const audio = classicMediaHTML({
    url: "/tone.wav",
    mime: "audio/wav",
    title: "Tone <Live>",
  });
  assert.match(audio, /^<audio controls="controls" preload="none"/);
  assert.match(audio, /Tone &lt;Live&gt;/);
  assert.doesNotMatch(audio, /\[audio/);
});
test("Classic link transport queries only the fixed search endpoint and escapes river result labels", async () => {
  const controller = new AbortController();
  let requested = "";
  const rows = await classicLinkQuery(
    "<b>search</b>",
    2,
    controller.signal,
    async (url, options) => {
      requested = String(url);
      assert.equal(options?.signal, controller.signal);
      return new Response(
        JSON.stringify([
          {
            id: 3,
            title: '<img src=x onerror="bad()">',
            url: "/posts/example/",
            subtype: "post",
          },
          {
            id: 4,
            title: "Page",
            url: "https://example.test/page/",
            subtype: "page",
          },
          { id: 5, title: "Bad", url: "javascript:bad()" },
        ]),
      );
    },
  );
  assert.match(requested, /^\/wp-json\/wp\/v2\/search\?/);
  assert.match(requested, /page=2/);
  assert.equal(rows.length, 2);
  assert.match(rows[0].title, /&lt;img/);
  assert.equal(rows[1].info, "Page");
  await assert.rejects(
    classicLinkQuery(
      "",
      1,
      controller.signal,
      async () => new Response("no", { status: 503 }),
    ),
    /could not be loaded/,
  );
});
function fixture() {
  const { window, document } = parseHTML(
    '<html><body><textarea id="one">Original content</textarea><textarea id="two">Second</textarea></body></html>',
  );
  const editors = new Map<string, any>(),
    calls: string[] = [];
  const win = window as unknown as ClassicWindow;
  win.wp = { media: { editor: { activeEditor: "one" } } };
  win.wpActiveEditor = "one";
  win.tinymce = { get: (id: string) => editors.get(id) };
  win.wpLink = {
    modalOpen: true,
    close() {
      calls.push("link:close");
      this.modalOpen = false;
    },
  };
  const source = {
    initialize(id: string, settings: any) {
      const handlers = new Map<string, Function[]>();
      const editor = {
        removed: false,
        on(name: string, fn: Function) {
          handlers.set(name, [...(handlers.get(name) || []), fn]);
        },
        remove() {
          if (this.removed) throw Error("double remove");
          this.removed = true;
          editors.delete(id);
          calls.push(id + ":remove");
        },
        fire(name: string) {
          for (const fn of handlers.get(name) || []) fn();
        },
      };
      editors.set(id, editor);
      settings.tinymce.setup(editor);
      return editor;
    },
    remove(id: string) {
      editors.get(id)?.remove();
    },
    getContent(id: string) {
      calls.push(id + ":content");
      return document.getElementById(id)!.textContent;
    },
  };
  return { win, document, editors, calls, source };
}
test("Classic composes native setup and retires per-ID editors without saving Cancel or touching peers", () => {
  const f = fixture(),
    errors: string[] = [];
  classicState(f.win).owners.set("one", {
    media() {},
    status: (e) => errors.push(e),
  });
  const wrapped = wrapClassicLifecycle(f.win, f.source);
  let aborted = 0;
  classicState(f.win).links.set("one", new Set([() => aborted++]));
  classicState(f.win).links.set("two", new Set([() => (aborted += 10)]));
  let setup = 0;
  wrapped.initialize("one", {
    tinymce: {
      setup(editor: any) {
        setup++;
        editor.on("init", () => setup++);
      },
    },
  });
  wrapped.initialize("two", { tinymce: {} });
  f.editors.get("one").fire("init");
  f.editors.get("two").fire("init");
  assert.equal(setup, 2);
  assert.equal(wrapped.getContent("one"), "Original content");
  const late = f.editors.get("one");
  wrapped.remove("one");
  late.fire("init");
  assert.equal(
    f.calls.filter((x) => x === "one:content").length,
    1,
    "cleanup never reads/commits content",
  );
  assert.equal(
    aborted,
    1,
    "retiring an editor aborts only its own link queries",
  );
  assert.equal(f.editors.has("one"), false);
  assert.equal(f.editors.has("two"), true);
  assert.equal(f.win.wpActiveEditor, undefined);
  assert.equal(f.win.wp.media.editor.activeEditor, undefined);
  assert.deepEqual(errors, [""]);
  wrapped.remove("two");
  assert.equal(f.editors.size, 0);
});
test("Classic pending initialization is canceled cleanly and failure keeps original textarea content", async () => {
  const f = fixture(),
    errors: string[] = [];
  classicState(f.win).owners.set("one", {
    media() {},
    status: (e) => errors.push(e),
  });
  const wrapped = wrapClassicLifecycle(f.win, f.source, 5);
  wrapped.initialize("one", { tinymce: {} });
  const editor = f.editors.get("one");
  await new Promise((resolve) => setTimeout(resolve, 15));
  editor.fire("init");
  assert.equal(f.editors.size, 0);
  assert.equal(
    f.document.getElementById("one")!.textContent,
    "Original content",
  );
  assert.equal(f.calls.includes("one:content"), false);
  assert.match(errors[0], /could not be loaded/);
  assert.equal(classicState(f.win).instances.size, 0);
});

test("Classic source floating controls retain modal ownership and viewport position across reflows", async () => {
  const { containClassicToolbar } =
    await import("../src/editor/classic/floating.js");
  const { document, window } = parseHTML(
    '<html><body><section id="modal"></section><div id="toolbar" aria-hidden="true"></div></body></html>',
  );
  const host = document.getElementById("modal")!,
    element = document.getElementById("toolbar")!;
  let left = 80,
    top = 30,
    reflows = 0;
  host.getBoundingClientRect = () => ({ left, top }) as DOMRect;
  Object.assign(host, { scrollLeft: 0, scrollTop: 0 });
  Object.assign(window, { scrollX: 0, scrollY: 0 });
  const toolbar = {
    getEl: () => element,
    reposition() {
      reflows++;
      element.style.left = "120px";
      element.style.top = "160px";
      return this;
    },
  };
  containClassicToolbar(
    toolbar,
    host as unknown as HTMLElement,
    window as unknown as Window,
  );
  assert.equal(element.parentElement, host);
  assert.equal(
    element.hasAttribute("aria-hidden"),
    false,
    "the modal's stale body-sibling flag cannot hide its own image/link controls",
  );
  toolbar.reposition();
  assert.equal(element.style.transform, "translate(-80px, -30px)");
  left = 100;
  top = 40;
  toolbar.reposition();
  assert.equal(element.style.transform, "translate(-100px, -40px)");
  assert.equal(element.style.left, "120px");
  containClassicToolbar(
    toolbar,
    host as unknown as HTMLElement,
    window as unknown as Window,
  );
  toolbar.reposition();
  assert.equal(
    reflows,
    3,
    "repeat containment does not wrap positioning twice",
  );
  element.remove();
  assert.equal(
    host.children.length,
    0,
    "the source toolbar retains its own remove lifecycle",
  );
});

test("Classic gallery edits use the official shortcode grammar and preserve source settings while updating real media order", async () => {
  const { readClassicGallery, writeClassicGallery } =
    await import("../src/editor/classic/gallery.js");
  const value = readClassicGallery(
    '[gallery ids="9,4,9" columns="2" link="file" size="medium" orderby="rand"]',
  )!;
  assert.deepEqual(value.ids, [9, 4, 9]);
  value.ids = [4, 9, 4, -1, 0, NaN];
  value.attrs.columns = "4";
  const output = writeClassicGallery(value);
  assert.deepEqual(readClassicGallery(output), {
    attrs: {
      ids: "4,9",
      columns: "4",
      link: "file",
      size: "medium",
      orderby: "rand",
    },
    ids: [4, 9],
  });
  assert.equal(readClassicGallery('[[gallery ids="9"]]'), null);
  assert.equal(readClassicGallery('[audio src="/tone.wav"]'), null);
});
test("narrow Classic image windows retain source controls and callbacks in a bounded stacked form", async () => {
  const { classicImageWindow } =
    await import("../src/editor/classic/imageWindow.js");
  const submit = () => {};
  const original = {
    title: "Insert/edit image",
    onSubmit: submit,
    body: [
      {
        type: "form",
        items: [
          { name: "alt", type: "textbox", label: "Image description" },
          {
            type: "form",
            layout: "grid",
            columns: 2,
            items: [{ name: "border", type: "textbox" }],
          },
        ],
      },
    ],
  };
  assert.equal(classicImageWindow(original, 1440), original);
  const fitted = classicImageWindow(original, 375, 812);
  assert.equal(fitted.onSubmit, submit);
  assert.equal(fitted.width, 351);
  assert.equal(fitted.height, 400);
  assert.equal(fitted.body[0].formItemDefaults.direction, "column");
  assert.equal(fitted.body[0].items[0].name, "alt");
  assert.equal(fitted.body[0].items[1].columns, 1);
  assert.equal(
    original.body[0].items[1].columns,
    2,
    "source specs are not mutated between different editor instances",
  );
});
test("Classic source windows and their blocker stay below a nested media modal inside their owner", async () => {
  const { containClassicWindow } =
    await import("../src/editor/classic/floating.js");
  const { document, window } = parseHTML(
    '<html><body><section id="owner"></section><div id="window" aria-hidden="true"></div><div id="mce-modal-block"></div></body></html>',
  );
  const host = document.getElementById("owner")!,
    element = document.getElementById("window")!;
  host.getBoundingClientRect = () => ({ left: 40, top: 80 }) as DOMRect;
  Object.assign(window, { innerWidth: 375, innerHeight: 812 });
  let reflowed = 0;
  const control = {
    getEl: () => element,
    reflow() {
      reflowed++;
      return this;
    },
  };
  containClassicWindow(
    control,
    host as unknown as HTMLElement,
    window as unknown as Window,
  );
  assert.equal(element.parentElement, host);
  assert.equal(element.getAttribute("aria-hidden"), null);
  assert.equal(element.style.transform, "translate(-40px, -80px)");
  assert.equal(document.getElementById("mce-modal-block")!.parentElement, host);
  assert.equal(
    document.getElementById("mce-modal-block")!.style.width,
    "375px",
  );
  control.reflow();
  assert.equal(reflowed, 1);
});
