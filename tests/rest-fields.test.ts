import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { projectRestFields } from "../server/rest-fields.js";

test("native REST field projection retains nested properties and array shape without unrelated metadata", () => {
  const value = [{ id: 1, title: { raw: "Private raw", rendered: "Public" }, caption: { raw: "Caption", rendered: "Caption" }, embedded: [{ id: 3, secret: "omit" }] }];
  assert.deepEqual(projectRestFields(value, "id,caption.raw,embedded.id"), [{ id: 1, caption: { raw: "Caption" }, embedded: [{ id: 3 }] }]);
  assert.deepEqual(projectRestFields(value, ["title.raw", "id"]), [{ title: { raw: "Private raw" }, id: 1 }]);
  assert.deepEqual(projectRestFields(value, "title.raw,title"), [{ title: value[0].title }]);
  assert.equal(projectRestFields(value, undefined), value); assert.equal(projectRestFields(value, ""), value);
  assert.deepEqual(projectRestFields(value, "unknown,caption.unknown"), [{ caption: {} }]);
});
test("REST field paths never read inherited/prototype data and reject excessive or malformed selectors", () => {
  const item = Object.assign(Object.create({ inherited: "omit" }), { id: 1 });
  assert.deepEqual(projectRestFields(item, "id,inherited,__proto__.polluted,constructor.name"), { id: 1 });
  assert.equal(({} as any).polluted, undefined);
  for (const invalid of [{ id: "yes" }, [1], "a..b", Array.from({ length: 11 }, () => "a").join("."), Array.from({ length: 101 }, () => "id")]) assert.throws(() => projectRestFields(item, invalid));
});
