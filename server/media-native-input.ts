import { z } from "zod";

/** Source core-data may send its read-only relation preview with metadata edits.
 * Inspect the complete raw JSON before discarding it, including prototype keys.
 * Nothing from this value is used to authorize, write or construct a response.
 */
export const readOnlyMediaEmbedsSchema = z.unknown().superRefine((input, context) => {
  const fail = () => context.addIssue({ code: "custom", message: "Read-only media relations must be an object within 32768 bytes, 512 values and eight levels." });
  if (!input || typeof input !== "object" || Array.isArray(input)) { fail(); return; }
  const pending = [{ value: input as unknown, depth: 0 }];
  let values = 0, bytes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++values > 512 || depth > 8) { fail(); return; }
    if (typeof value === "string") bytes += Buffer.byteLength(value, "utf8");
    else if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (entries.length + values + pending.length > 512) { fail(); return; }
      for (const [key, child] of entries) {
        bytes += Buffer.byteLength(key, "utf8");
        pending.push({ value: child, depth: depth + 1 });
      }
    }
    if (bytes > 32768) { fail(); return; }
  }
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 32768) fail();
});
