import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { normalizeBlockRenderAttributes } from "../server/block-render-attributes.js";

test("registered renderer types coerce transport strings without changing text or unknown data", () => {
  const schemas = { count: { type: "number" }, enabled: { type: "boolean" }, label: { type: "string" }, integer: { type: "integer" }, nested: { type: "object", properties: { visible: { type: "boolean" } } }, items: { type: "array", items: { type: "number" } } };
  const input = { count: "2", enabled: "false", label: "false", integer: "2.0", nested: { visible: "TRUE", untouched: "0" }, items: ["1", "2.5"], extension: { unchanged: "false" } };
  assert.deepEqual(normalizeBlockRenderAttributes(input, schemas), { count: 2, enabled: false, label: "false", integer: 2, nested: { visible: true, untouched: "0" }, items: [1, 2.5], extension: { unchanged: "false" } });
  assert.equal(input.enabled, "false", "Normalization never mutates a caller's object");
  for (const value of [false, "FALSE", "0", 0]) assert.equal(normalizeBlockRenderAttributes({ enabled: value }, schemas).enabled, false);
  for (const value of [true, "TRUE", "1", 1]) assert.equal(normalizeBlockRenderAttributes({ enabled: value }, schemas).enabled, true);
  assert.equal(normalizeBlockRenderAttributes({ count: " 1e2 " }, schemas).count, 100);
});

test("renderer attribute normalization rejects invalid types, unsafe integers and excessive input", () => {
  for (const [value, type] of [["yes", "boolean"], ["", "number"], ["NaN", "number"], ["1e999", "number"], ["2.5", "integer"], [9007199254740992, "integer"], [null, "boolean"], [true, "number"], [{}, "string"], [[], "object"]] as const) {
    assert.throws(() => normalizeBlockRenderAttributes({ value }, { value: { type } }), (error: any) => error.status === 400);
  }
  assert.throws(() => normalizeBlockRenderAttributes({ text: "x".repeat(100001) }, {}), /too large/);
  const deep: Record<string, unknown> = {}; let current = deep;
  for (let i = 0; i < 30; i++) { const next = {}; current.nested = next; current = next; }
  assert.throws(() => normalizeBlockRenderAttributes(deep, {}), /too complex/);
  assert.throws(() => normalizeBlockRenderAttributes(JSON.parse('{"prototype":"' + "x".repeat(100001) + '","ok":true}'), {}), /too large/);
  assert.throws(() => normalizeBlockRenderAttributes(JSON.parse('{"__proto__":' + "[".repeat(30) + "0" + "]".repeat(30) + '}'), {}), /too complex/);
  const cleaned = normalizeBlockRenderAttributes(JSON.parse('{"constructor":{},"nested":{"__proto__":{"bad":true}},"text":"safe"}'), {});
  assert.deepEqual(cleaned, { nested: {}, text: "safe" });
});
