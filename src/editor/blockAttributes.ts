/** Keep Gutenberg's local editor selection out of durable document JSON. */
export function persistentBlockAttributes(
  attributes: Record<string, unknown>,
  schema: Record<string, { role?: string }> = {},
): Record<string, unknown> {
  const persistent = Object.fromEntries(Object.entries(attributes).filter(([name]) => schema[name]?.role !== 'local'));
  // RichTextData implements toJSON; detach Gutenberg's mutable values as before.
  return JSON.parse(JSON.stringify(persistent)) as Record<string, unknown>;
}
