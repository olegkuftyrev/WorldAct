/** Source pagination can receive a canonical Plain URL as requestPath. Merge
 * its visible query once, and keep renderer-only body selection off links. */
export function isPublicRequestPath(value: string): boolean {
  // Browsers treat a backslash in the path like a slash; /\host must never
  // become an external authority. Encoded path segments remain untouched.
  return value.startsWith("/") && !value.startsWith("//") &&
    !/[\u0000-\u001f\u007f]/.test(value) && !value.split(/[?#]/,1)[0].includes("\\");
}
export function publicPaginationLocation(requestPath: string | undefined, values: Record<string, unknown> = {}) {
  const relative = requestPath && isPublicRequestPath(requestPath) ? requestPath : "/";
  const [beforeHash] = relative.split("#"), separator = beforeHash.indexOf("?");
  const path = separator < 0 ? beforeHash : beforeHash.slice(0, separator);
  const query = new URLSearchParams(separator < 0 ? "" : beforeHash.slice(separator + 1));
  const internal = new Set(["postId", "requestPath", "type", "contentPage"]);
  for (const [key, value] of Object.entries(values))
    if (!internal.has(key) && (typeof value === "string" || typeof value === "number"))
      query.set(key.slice(0, 80), String(value).slice(0, 300));
  for (const key of internal) query.delete(key);
  return { path: path || "/", query };
}
