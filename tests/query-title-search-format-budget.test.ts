import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { escapeSearchQueryTitleTerm } from "../server/search-query-fields.js";
import { HttpError } from "../server/utils.js";

// These direct imports exercise SOURCE code even when the API uses its bundle.
const isLimit = (error: unknown) => error instanceof HttpError && error.status === 413;

test("search title escaping fits the complete UTF-8 heading budget exactly", () => {
  const term = `Café 😀 &amp; <x> "q" 'r' &#00065;`;
  const escaped = "Café 😀 &amp; &lt;x&gt; &quot;q&quot; &#039;r&#039; &#065;";
  const open = '<h2 class="wp-block-query-title café" id="quoted" style="color:red">';
  const surrounding = Buffer.byteLength(open + "Search results for: &#8220;&#8221;</h2>", "utf8");
  const complete = surrounding + Buffer.byteLength(escaped, "utf8");
  assert.equal(escapeSearchQueryTitleTerm(term, complete, surrounding), escaped);
  assert.throws(() => escapeSearchQueryTitleTerm(term, complete - 1, surrounding), isLimit);
});

test("search title budgets reject invalid or negative allowances before an empty term", () => {
  assert.equal(escapeSearchQueryTitleTerm("", 0, 0), "");
  assert.equal(escapeSearchQueryTitleTerm("", 19, 19), "");
  for (const [remaining, surrounding] of [
    [-1, 0], [0, 1], [1, -1], [NaN, 0], [Infinity, 0], [-Infinity, 0],
    [0, NaN], [0, Infinity], [0, -Infinity],
  ]) assert.throws(() => escapeSearchQueryTitleTerm("", remaining, surrounding), isLimit);
});

test("search title references compact valid zero runs and retain bounded escape rules", () => {
  const zeros = "0".repeat(16_384);
  assert.equal(escapeSearchQueryTitleTerm("&#" + zeros + "65;", 6, 0), "&#065;");
  assert.throws(() => escapeSearchQueryTitleTerm("&#X" + zeros + "D800;", 128, 0), isLimit);
  assert.equal(escapeSearchQueryTitleTerm("&#X000D800;", 128, 0), "&amp;#x000D800;");
  const term = "&amp; &apos; &unknown; &#0000; &#X0000;";
  const escaped = "&amp; &amp;apos; &amp;unknown; &amp;#0000; &amp;#X0000;";
  assert.equal(escapeSearchQueryTitleTerm(term, Buffer.byteLength(escaped, "utf8"), 0), escaped);
});
