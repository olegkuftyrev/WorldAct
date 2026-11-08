/** Keep native parser values intact while removing source-local selection. */
export function editorBlockAttributes(
  attributes: Record<string, unknown>,
  schema: Record<string, { role?: string }> = {},
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(attributes).filter(([name]) => schema[name]?.role !== 'local'));
}

/** Keep Gutenberg's local editor selection out of durable document JSON. */
export function persistentBlockAttributes(
  attributes: Record<string, unknown>,
  schema: Record<string, { role?: string }> = {},
): Record<string, unknown> {
  const persistent = editorBlockAttributes(attributes, schema);
  // RichTextData implements toJSON; detach Gutenberg's mutable values as before.
  return JSON.parse(JSON.stringify(persistent)) as Record<string, unknown>;
}
