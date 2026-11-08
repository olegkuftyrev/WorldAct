import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { findOwnedFootnotes } from "../src/editor/footnoteScope.js";

test("owner Footnotes lookup excludes query/template/reusable entity boundaries and finds normal nested lists", () => {
  const queried = { name: "core/footnotes", clientId: "queried", innerBlocks: [] };
  const owned = { name: "core/footnotes", clientId: "owned", innerBlocks: [] };
  for (const boundary of ["core/query", "core/post-template", "core/post-content", "core/template-part", "core/block", "core/pattern"]) {
    const foreign = { name: boundary, clientId: "boundary", innerBlocks: [queried] };
    assert.equal(findOwnedFootnotes([foreign]), null, `${boundary} cannot satisfy the owner's notes list`);
    assert.equal(findOwnedFootnotes([foreign, { name: "core/group", clientId: "group", innerBlocks: [owned] }]), owned);
  }
  assert.equal(findOwnedFootnotes([{ name: "core/columns", clientId: "columns", innerBlocks: [{ name: "core/column", clientId: "column", innerBlocks: [owned] }] }]), owned);
});
