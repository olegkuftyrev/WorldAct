import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { shouldResolveStaticFrontPage } from "../src/plainPermalinkRouting.js";
import { readPlainPermalinkQuery } from "../shared/plain-permalink-query.js";

const front = { settings: { frontPageMode: "page" as const, frontPageId: 7 }, frontPage: { id: 7 } };
test("root identity decisions preserve malformed fixed IDs and only interpret page-only queries with actual static-front context", () => {
  for (const query of ["p=12", "page_id=7&page=2", "p[]=12", "p=0", "p=12&p=13", "p=12&page=0"])
    assert.notEqual(readPlainPermalinkQuery(new URLSearchParams(query)).kind, "none", query);
  assert.equal(readPlainPermalinkQuery(new URLSearchParams("page=2")).kind, "none");
  for (const query of ["page=2", "page=0", "page[]=2", "page=2&page=3", "page=2&query-4-page=3&commentPage=2"])
    assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams(query), front), true, query);
  assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams("page=2"), null), false);
  assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams("page=2"), { settings: { frontPageMode: "posts" }, frontPage: null }), false);
  assert.equal(shouldResolveStaticFrontPage("/parent/child", new URLSearchParams("page=2"), front), false);
  for (const filter of ["s", "search", "category", "tag", "author", "year", "monthnum", "day", "m", "w"])
    assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams(`page=2&${filter}=example`), front), false, filter);
  assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams("query-4-page=2&commentPage=2"), front), false);
});

test("a saved static-front identity delegates to the real resolver when its public object disappears, including unpaginated root", () => {
  const missing = { settings: { frontPageMode: "page" as const, frontPageId: 7 }, frontPage: null };
  for (const query of ["", "page=2", "page=0", "page[]=2", "query-4-page=2", "commentPage=2", "page=2&query-4-page=3&commentPage=2"])
    assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams(query), missing), true, query);
  for (const filter of ["s", "search", "category", "tag", "author", "year", "month", "monthnum", "day", "m", "w"]){
    assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams(`page=2&${filter}=actual-filter`), missing), false, filter);
    for (const query of [`${filter}=`, `page=2&${filter}=`, `${filter}[]=`])
      assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams(query), missing), true, query);
    assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams(`page=2&${filter}=`), front), true, `Published body2: ${filter}`);
  }
  assert.equal(shouldResolveStaticFrontPage("/another-page/", new URLSearchParams(), missing), false);
  for (const frontPageId of [null, undefined])
    assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams("page=2"), { settings: { frontPageMode: "page", frontPageId }, frontPage: null }), false);
  for (const query of ["", "page=2", "query-4-page=2&commentPage=2"])
    assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams(query), { settings: { frontPageMode: "posts", frontPageId: 7 }, frontPage: null }), false, query);
  assert.equal(shouldResolveStaticFrontPage("/", new URLSearchParams(), { ...missing, frontPage: { id: 8 } }), true, "A different available page cannot replace the selected identity.");
});
