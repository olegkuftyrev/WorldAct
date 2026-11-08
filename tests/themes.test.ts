import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { parse } from "@wordpress/block-serialization-default-parser";
import { bundledThemes, getThemeVariation, resolveThemeJSON, validateThemeDesign } from "../server/themes.js";
import { compileThemeStyles } from "../src/themeStyles.js";
import { themeDocument, resolveThemeValue } from "../src/themeCatalog.js";
import { cleanRawContent } from "../server/utils.js";
import { rootDir } from "../server/db.js";

test("bundled source themes preserve all canonical documents and resolve their dependencies", async () => {
  assert.deepEqual(bundledThemes.map((theme) => [theme.id,theme.version,theme.templates.length,theme.parts.length,theme.patterns.length,theme.variations.length]),[
    ["twentytwentyfive","1.5",8,7,98,32], ["twentytwentyfour","1.6",11,4,59,7], ["twentytwentythree","1.7",9,4,7,10],
  ]);
  let documents = 0, blocks = 0;
  for (const theme of bundledThemes) {
    const sourceNames = new Set(theme.sourceFiles.map((source) => source.path));
    const slugs = new Set(theme.patterns.map((pattern) => theme.id+"/"+pattern.slug));
    const parts = new Set(theme.parts.map((part) => part.slug));
    const visit = (nodes: any[]) => {
      for (const node of nodes) {
        if(node.blockName) blocks++;
        if(node.blockName === "core/pattern") assert.ok(slugs.has(node.attrs.slug) || slugs.has(theme.id+"/"+node.attrs.slug),`Missing pattern ${node.attrs.slug}`);
        if(node.blockName === "core/template-part") assert.ok(parts.has(node.attrs.slug),`Missing template part ${node.attrs.slug}`);
        visit(node.innerBlocks || []);
      }
    };
    for (const document of [...theme.templates,...theme.parts,...theme.patterns]) {
      documents++;
      assert.ok(sourceNames.has(document.source));
      assert.match(document.sourceHash,/^[a-f0-9]{64}$/);
      assert.doesNotMatch(document.content,/<\?(?:php|=)|get_template_directory_uri|esc_html_e\(/);
      const original = parse(document.content), canonical = parse(cleanRawContent(document.content));
      assert.ok(original.some((node:any) => node.blockName),document.source);
      const names = (items:any[]): unknown[] => items.map((item) => [item.blockName,names(item.innerBlocks || [])]);
      assert.deepEqual(names(canonical),names(original),`Canonical block hierarchy changed: ${document.source}`);
      visit(canonical);
      for (const match of document.content.matchAll(/(?:src|poster)="(\/vendor\/wordpress\/[^"?#]+)"/g))
        await access(path.join(rootDir,"public",match[1]));
    }
  }
  assert.equal(documents,207);
  assert.ok(blocks > 2000);
});

test("theme.json presets, fonts and original style variations compile without PHP or external assets", async () => {
  for (const theme of bundledThemes) {
    for (const variation of ["",...theme.variations.filter((item) => item.type === "theme").map((item) => item.slug)]) {
      const document = resolveThemeJSON(theme.id,variation)!;
      assert.deepEqual(themeDocument(theme.id,variation),document,"Editor and server must use identical tokens");
      const css = compileThemeStyles(document);
      assert.match(css,/--wp--style--global--content-size:/);
      assert.match(css,/--wp--preset--color--base:/);
      assert.match(css,/\.worldact-theme/);
      const familyNames=new Set((document.settings.typography.fontFamilies || []).map((item:any)=>item.slug));
      for(const token of JSON.stringify(document.styles).matchAll(/var(?::preset\|font-family\||\(--wp--preset--font-family--)([a-z0-9-]+)/g))assert.ok(familyNames.has(token[1]),`Missing font preset ${theme.id}/${variation}: ${token[1]}`);
      assert.doesNotMatch(css,/file:\.\/|<\?php|undefined|\[object Object\]/);
      for(const family of document.settings.typography.fontFamilies || [])
        for(const face of family.fontFace || [])
          for(const src of face.src || []) {
            assert.match(src,/^\/vendor\/wordpress\/wp-content\/themes\//);
            await access(path.join(rootDir,"public",src));
          }
    }
  }
  assert.equal(resolveThemeValue("var:preset|font-family|manrope",resolveThemeJSON("twentytwentyfive")),"Manrope, sans-serif");
  assert.equal(resolveThemeValue("var(--wp--preset--color--base)",resolveThemeJSON("twentytwentyfour")),"#f9f9f9");
  const css = compileThemeStyles(resolveThemeJSON("twentytwentyfive")!);
  assert.match(css,/--wp--style--global--content-size:645px/);
  assert.match(css,/--wp--style--global--wide-size:1340px/);
  assert.match(css,/--wp--preset--spacing--50:clamp\(30px, 5vw, 50px\)/);
});

test("theme designs validate known variations and bounded flat overrides", () => {
  assert.ok(getThemeVariation("twentytwentyfive","06-morning"));
  assert.equal(getThemeVariation("twentytwentyfive","typography/typography-preset-1"),undefined);
  assert.deepEqual(validateThemeDesign("twentytwentyfour",{variation:"onyx",styles:{textColor:"#eeeeee",contentWidth:1280}}),{theme:"twentytwentyfour",variation:"onyx",styles:{textColor:"#eeeeee",contentWidth:1280}});
  assert.throws(() => validateThemeDesign("unknown",{styles:{}}));
  assert.throws(() => validateThemeDesign("twentytwentyfour",{variation:"06-morning"}));
  assert.throws(() => validateThemeDesign("twentytwentyfour",{styles:{fontFamily:"url(javascript:alert(1))"}}));
  assert.throws(() => validateThemeDesign("twentytwentyfour",{styles:{contentWidth:999999}}));
  assert.throws(() => validateThemeDesign("twentytwentyfour",{styles:{css:"body{display:none}"}}));
});

test("bundled font licenses travel with the original assets", async () => {
  const files = [
    "twentytwentyfive/assets/fonts/manrope/OFL.txt",
    "twentytwentyfive/readme.txt",
    "twentytwentyfour/assets/fonts/cardo/LICENSE.txt",
    "twentytwentythree/assets/fonts/dm-sans/LICENSE.txt",
    "twentytwentythree/assets/fonts/inter/LICENSE.txt",
    "twentytwentythree/assets/fonts/ibm-plex-mono/OFL.txt",
    "twentytwentythree/assets/fonts/source-serif-pro/LICENSE.md",
  ];
  for (const file of files) {
    const content = await readFile(path.join(rootDir,"public/vendor/wordpress/wp-content/themes",file),"utf8");
    assert.match(content,/license|copyright/i,file);
  }
});
