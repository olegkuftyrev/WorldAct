/** Restore the browser's More-link fragment after asynchronous content arrives. */
export function scrollToMoreFragment(root: ParentNode | null): () => void {
  if (!root) return () => {};
  const document = root.nodeType === 9 ? root as Document : root.ownerDocument;
  const view = document?.defaultView;
  if (!document || !view) return () => {};
  let id: string;
  try { id = decodeURIComponent(view.location.hash.slice(1)); } catch { return () => {}; }
  if (!/^more-\d{1,16}$/.test(id)) return () => {};
  const target = document.getElementById(id);
  if (!target || !root.contains(target)) return () => {};
  const frame = view.requestAnimationFrame(() => {
    if (target.isConnected) target.scrollIntoView({ block: "start" });
  });
  return () => view.cancelAnimationFrame(frame);
}
