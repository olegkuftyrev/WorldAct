import { HttpError } from "./utils.js";

type AttributeSchema = { type?: string | string[]; properties?: Record<string, AttributeSchema>; items?: AttributeSchema };
const numeric = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** Fixed block.json types, matching the source REST renderer's scalar coercion. */
export function normalizeBlockRenderAttributes(input: Record<string, unknown>, schemas: Record<string, AttributeSchema>): Record<string, unknown> {
  let values = 0, bytes = 0;
  const charge = (amount: number) => {
    bytes += amount;
    if (bytes > 100000) throw new HttpError(400, "The block attributes are too large.");
  };
  const invalid = () => { throw new HttpError(400, "A block attribute has an invalid type."); };
  function walk(value: unknown, schema: AttributeSchema | undefined, depth: number): unknown {
    if (++values > 25000 || depth > 25) throw new HttpError(400, "The block attributes are too complex.");
    const types = schema?.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : [];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    let result = value;
    if (["undefined", "function", "symbol", "bigint"].includes(actual)) return invalid();
    if (actual === "string") {
      if ((value as string).length > 100000) throw new HttpError(400, "The block attributes are too large.");
      charge(Buffer.byteLength(JSON.stringify(value)));
    } else if (actual === "number") {
      if (!Number.isFinite(value)) return invalid();
      charge(String(value).length);
    } else if (actual === "boolean" || actual === "null") charge(actual === "null" ? 4 : value ? 4 : 5);

    // Strings already valid for a union keep their string meaning.
    if (types.length && !types.includes(actual) && !(actual === "string" && types.includes("rich-text"))) {
      if (types.includes("boolean") && (typeof value === "string" && /^(?:true|false|0|1)$/i.test(value) || value === 0 || value === 1)) {
        result = value === 1 || typeof value === "string" && ["true", "1"].includes(value.toLowerCase());
      } else if ((types.includes("number") || types.includes("integer")) && typeof value === "string" && numeric.test(value.trim()) && Number.isFinite(Number(value))) {
        result = Number(value);
      } else if (!(actual === "number" && types.includes("integer"))) return invalid();
    }
    if (types.includes("integer") && !types.includes("number") && typeof result === "number" && !Number.isSafeInteger(result)) return invalid();
    if (Array.isArray(value)) {
      charge(2 + value.length);
      return value.map(item => walk(item, schema?.items, depth + 1));
    }
    if (value !== null && typeof value === "object") {
      charge(2);
      const entries: Array<[string, unknown]> = [];
      for (const [key, item] of Object.entries(value)) {
        if (key.length > 100000) throw new HttpError(400, "The block attributes are too large.");
        charge(Buffer.byteLength(JSON.stringify(key)) + 2);
        if (["__proto__", "prototype", "constructor"].includes(key)) {
          // Discarded values still belong to the input resource budget.
          walk(item, undefined, depth + 1);
          continue;
        }
        entries.push([key, walk(item, schema?.properties?.[key], depth + 1)]);
      }
      return Object.fromEntries(entries);
    }
    return result;
  }
  return walk(input, { type: "object", properties: schemas }, 0) as Record<string, unknown>;
}
