import { after, test } from "./isolated-test.js";
import "dotenv/config";
import assert from "node:assert/strict";
import { DOMParser } from "linkedom";
import { pool } from "../server/db.js";
import { renderSiteDocument } from "../server/block-renderer.js";
import { gridLength, gridTemplateColumns, gridTemplateColumnsPattern } from "../server/block-layout.js";
import { cleanContent } from "../server/utils.js";

after(async () => {await pool.end();});

test("native grid lengths and generated expressions survive sanitization without accepting CSS injection", () => {
  assert.equal(gridLength("var:preset|spacing|40"), "var(--wp--preset--spacing--40)");
  for (const invalid of ["-2px", "0px", "10001px", "url(https://example.invalid)", "12rem;display:none", "expression(alert(1))", "var(--custom)", "1px)/*"]) assert.equal(gridLength(invalid), null);
  for (const [layout, gap] of [
    [{type:"grid",columnCount:3},undefined],
    [{type:"grid"},undefined],
    [{type:"grid",columnCount:3,minimumColumnWidth:"12rem"},undefined],
    [{type:"grid",columnCount:2,minimumColumnWidth:"var:preset|spacing|40",autoFit:true},{top:"2rem",left:"8px"}],
    [{type:"grid",columnCount:2,minimumColumnWidth:"120px"},0],
    [{type:"grid",columnCount:16,minimumColumnWidth:"120px"},"0px"],
  ] as const) {
    const value=gridTemplateColumns(layout,gap);
    assert.ok(gridTemplateColumnsPattern.test(value),value);
    assert.ok(cleanContent(`<div style="display:grid;grid-template-columns:${value}">Grid</div>`).includes("grid-template-columns:"),value);
  }
  for (const value of ["repeat(2,minmax(url(https://example.invalid),1fr))", "repeat(2, minmax(expression(alert(1)), 1fr))", "repeat(2, minmax(var(--custom), 1fr))", "repeat(1001, minmax(0, 1fr))"]) assert.doesNotMatch(cleanContent(`<div style="grid-template-columns:${value}">Grid</div>`),/grid-template-columns/);
});

test("real renderer preserves source fixed, adaptive and preset grid layout on Latest Posts", async () => {
  const db=await pool.connect();await db.query("BEGIN");
  try {
    const user=(await db.query("SELECT id FROM users WHERE role='administrator' ORDER BY id LIMIT 1")).rows[0];
    const stamp="grid-"+Date.now().toString(36);
    const post=(await db.query("INSERT INTO posts(type,title,slug,status,author_id,published_at) VALUES('post',$1,$1,'publish',$2,now()) RETURNING id",[stamp,user.id])).rows[0];
    const category=(await db.query("INSERT INTO terms(taxonomy,name,slug) VALUES('category',$1,$1) RETURNING id",[stamp])).rows[0];
    await db.query("INSERT INTO post_terms(post_id,term_id) VALUES($1,$2)",[post.id,category.id]);
    const render=async(layout:Record<string,unknown>,gap?:unknown)=>new DOMParser().parseFromString(await renderSiteDocument({blocks:[{name:"core/latest-posts",attributes:{layout,categories:[{id:category.id}],style:{spacing:{blockGap:gap}}},innerBlocks:[]}]},{db}),"text/html").querySelector("ul")!;
    const fixed=await render({type:"grid",columnCount:3});
    assert.match(fixed.getAttribute("style")!,/grid-template-columns:repeat\(3, minmax\(0, 1fr\)\)/);
    assert.ok(!fixed.classList.contains("has-native-responsive-grid"));
    const adaptive=await render({type:"grid",columnCount:3,minimumColumnWidth:"12rem"});
    assert.ok(adaptive.classList.contains("wp-block-latest-posts-is-layout-grid"));
    assert.ok(adaptive.classList.contains("has-native-responsive-grid"));
    assert.match(adaptive.getAttribute("style")!,/auto-fill.*12rem.*var\(--wp--style--block-gap, 1\.2rem\)/);
    const fit=await render({type:"grid",columnCount:2,minimumColumnWidth:"var:preset|spacing|40",autoFit:true},{left:"8px"});
    assert.match(fit.getAttribute("style")!,/auto-fit.*var\(--wp--preset--spacing--40\).*8px/);
    const invalid=await render({type:"grid",columnCount:2,minimumColumnWidth:"url(https://example.invalid)"});
    assert.doesNotMatch(invalid.outerHTML,/url\(|example\.invalid/);
    assert.ok(!invalid.classList.contains("has-native-responsive-grid"));
    const zero=await render({type:"grid",columnCount:16,minimumColumnWidth:"120px"},"0px");
    assert.match(zero.getAttribute("style")!,/0px \* \(16 - 1\)/);
    assert.ok(zero.classList.contains("columns-16"));
    const group=new DOMParser().parseFromString(await renderSiteDocument({content:'<!-- wp:group {"layout":{"type":"grid","columnCount":16}} --><div></div><!-- /wp:group -->',blocks:[{name:"core/group",attributes:{layout:{type:"grid",columnCount:16}},innerBlocks:[]}]},{db}),"text/html").querySelector("div")!;
    assert.match(group.getAttribute("style")!,/repeat\(16, minmax\(0, 1fr\)\)/);
    assert.ok(!group.classList.contains("has-native-responsive-grid"));
  } finally {await db.query("ROLLBACK");db.release();}
});
