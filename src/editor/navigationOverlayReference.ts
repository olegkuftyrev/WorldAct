/** The native picker stores slugs; the renderer also accepts legacy full IDs. */
export function overlayPickerReference(value: unknown, activeTheme?: string) {
  if (typeof value !== "string" || !activeTheme) return value;
  const full = /^([a-z0-9_-]{1,120})\/\/([a-z0-9_-]{1,160})$/.exec(value);
  return full?.[1] === activeTheme ? full[2] : value;
}
