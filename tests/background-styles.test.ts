import test, { after } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { backgroundStyles, safeBackgroundURL } from "../server/background-styles.js";
import { cleanContent, cleanRawContent } from "../server/utils.js";
import { defaultSettings, pool } from "../server/db.js";
import { renderSiteDocument, type SerializedNode } from "../server/block-renderer.js";
import { remapImportedBlockReferences } from "../server/block-portability.js";

const dom = (html: string) => new DOMParser().parseFromString("<!doctype html><html><body>" + html + "</body></html>", "text/html");
const node = (name: string, attributes: Record<string, unknown> = {}, innerBlocks: SerializedNode[] = []): SerializedNode => ({ name: "core/" + name, attributes, innerBlocks });
const settingsOnly = { query: async (sql: string) => { assert.match(sql, /FROM settings/); return { rows: [{ data: defaultSettings }] }; } } as any;
const block = (name: string, attributes: Record<string, unknown>, html: string) => `<!-- wp:${name} ${JSON.stringify(attributes)} -->${html}<!-- /wp:${name} -->`;
after(async () => { await pool.end(); });

test("background image URLs preserve local and remote media while encoding CSS delimiters", () => {
  assert.equal(safeBackgroundURL("/uploads/image.jpg?size=large#crop"), "/uploads/image.jpg?size=large#crop");
  assert.equal(safeBackgroundURL("https://images.example.test/picture.jpg?x=1&y=2"), "https://images.example.test/picture.jpg?x=1&y=2");
  const encoded = safeBackgroundURL('/uploads/a ("quoted\');).jpg');
  assert.ok(encoded.startsWith("/uploads/a%20%28%22quoted%27%29%3B%29.jpg"), encoded);
  assert.doesNotMatch(encoded, /[\s'"();<>\\]/);
  for (const invalid of ["javascript:alert(1)", "data:image/svg+xml,x", "//other.test/x", "https://user:password@other.test/x", "https://[bad", "/uploads/x\n.jpg", "/uploads/\\bad", "x".repeat(5000), {}, null])
    assert.equal(safeBackgroundURL(invalid), "", JSON.stringify(invalid));
});

test("background support combines native image and gradient layers with source sizing defaults", () => {
  assert.equal(backgroundStyles({ backgroundImage: { url: "/uploads/photo.jpg" } }), 'background-image:url("/uploads/photo.jpg");background-size:cover');
  assert.equal(backgroundStyles({ backgroundImage: { url: "/uploads/photo.jpg" }, backgroundSize: "contain" }), 'background-image:url("/uploads/photo.jpg");background-size:contain;background-position:50% 50%');
  const styles = backgroundStyles({ backgroundImage: { url: "/uploads/photo.jpg" }, gradient: "var:preset|gradient|sunset", backgroundSize: "50% auto", backgroundPosition: "right 10px bottom 20px", backgroundRepeat: "no-repeat", backgroundAttachment: "fixed" });
  assert.equal(styles, 'background-image:url("/uploads/photo.jpg"), var(--wp--preset--gradient--sunset);background-size:50% auto;background-position:right 10px bottom 20px;background-repeat:no-repeat;background-attachment:fixed');
  assert.equal(backgroundStyles({ backgroundImage: { url: "javascript:bad()" }, gradient: "linear-gradient(90deg, #fff, rgba(0,0,0,.4))" }), "background-image:linear-gradient(90deg, #fff, rgba(0,0,0,.4))");
  assert.equal(backgroundStyles({ backgroundImage: 'url("/a"),url("/b")', gradient: 'url("/not-a-gradient")', backgroundSize: "cover;position:fixed", backgroundPosition: "url(evil)", backgroundRepeat: "repeat!important", backgroundAttachment: "expression(x)" }), "");
});

test("canonical CSS preserves bounded background styles and rejects injected or executable values", () => {
  const good = cleanContent('<div style="background-image:url(\'/uploads/photo.jpg\'),linear-gradient(90deg,#fff,var(--wp--preset--color--contrast));background-size:contain;background-position:50% 50%;background-repeat:no-repeat;background-attachment:local">Body</div>');
  const style = dom(good).querySelector("div")!.getAttribute("style")!;
  for (const property of ["background-image:url(", "linear-gradient(", "background-size:contain", "background-position:50% 50%", "background-repeat:no-repeat", "background-attachment:local"]) assert.ok(style.includes(property), style);
  for (const invalid of ["url(javascript:alert(1))", "url(data:image/png;base64,abc)", "url(//other.test/x)", 'url("/x") junk', 'url("/a"),url("/b"),url("/c")', 'u\\72l("/x")', "expression(alert(1))", "linear-gradient(red, url(https://other.test/x))"]) {
    const escaped = invalid.replace(/"/g, "&quot;");
    const cleaned = dom(cleanContent(`<div style="background-image:${escaped};color:#123456">Body</div>`));
    assert.doesNotMatch(cleaned.querySelector("div")!.getAttribute("style")!, /background-image/, invalid);
    assert.match(cleaned.querySelector("div")!.getAttribute("style")!, /color:#123456/);
  }
});

test("native accordion and canonical Group metadata render image styles after gradient shorthands", async () => {
  const style = { background: { backgroundImage: { url: "/uploads/source.jpg" }, backgroundSize: "contain", gradient: "linear-gradient(90deg,#ffffff,#123456)" }, color: { gradient: "linear-gradient(0deg,#000000,#ffffff)" } };
  const raw = block("group", { style }, '<div class="wp-block-group"><p>Canonical body</p></div>');
  const canonical = dom(await renderSiteDocument({ rawContent: cleanRawContent(raw) }, { db: settingsOnly }));
  const group = canonical.querySelector(".wp-block-group")!;
  assert.match(group.getAttribute("style")!, /background-image:url\("\/uploads\/source.jpg"\), linear-gradient/);
  assert.match(group.getAttribute("style")!, /background-position:50% 50%/);
  const rendered = dom(await renderSiteDocument({ blocks: [node("accordion", { style }, [node("accordion-item", {}, [node("accordion-heading", { title: "Image accordion" }), node("accordion-panel", {}, [node("paragraph", { content: "Visible body" })])])])] }, { db: settingsOnly }));
  const accordion = rendered.querySelector(".wp-block-accordion")!, css = accordion.getAttribute("style")!;
  assert.ok(accordion.classList.contains("has-background"));
  assert.ok(css.indexOf("background-image:") > css.lastIndexOf("background:"), css);
  assert.match(css, /background-size:contain/); assert.match(css, /background-position:50% 50%/);
  assert.match(rendered.body.textContent!, /Visible body/);
});

test("Tab List background support targets native tab buttons rather than the list wrapper", async () => {
  const parsed = dom(await renderSiteDocument({ blocks: [node("tabs", {}, [node("tab-list", { style: { background: { backgroundImage: { url: "/uploads/tab.jpg" }, backgroundRepeat: "no-repeat" } } }), node("tab-panels", {}, [node("tab-panel", { label: "One" }, [node("paragraph", { content: "Body" })])])])] }, { db: settingsOnly }));
  assert.doesNotMatch(parsed.querySelector('[role="tablist"]')!.getAttribute("style") || "", /background/);
  const button = parsed.querySelector('[role="tab"]')!;
  assert.match(button.getAttribute("style")!, /background-image:url\("\/uploads\/tab.jpg"\)/);
  assert.match(button.getAttribute("style")!, /background-size:cover/);
  assert.match(button.getAttribute("style")!, /background-repeat:no-repeat/);
});

test("archive image URL mapping handles entity-quoted CSS without rewriting foreign embedded paths", () => {
  const original = "/uploads/source.jpg", target = "/uploads/imported.jpg";
  const raw = block("group", { style: { background: { backgroundImage: { url: original } } } }, '<div class="wp-block-group" style="padding:20px;background-image:url(&quot;/uploads/source.jpg&quot;);background-size:cover"><a href="https://foreign.test/?next=/uploads/source.jpg">Foreign</a></div>');
  const result = remapImportedBlockReferences(raw, [node("group", { style: { background: { backgroundImage: { url: original } } } })], new Map(), { urls: new Map([[original, target]]) });
  const parsed = dom(result.rawContent), group = parsed.querySelector(".wp-block-group")!;
  assert.match(group.getAttribute("style")!, /url\("\/uploads\/imported.jpg"\)/);
  assert.equal(parsed.querySelector("a")!.getAttribute("href"), "https://foreign.test/?next=/uploads/source.jpg");
  assert.equal((result.blocks[0].attributes as any).style.background.backgroundImage.url, target);
});
