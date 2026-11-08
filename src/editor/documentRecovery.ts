import type { Footnote, SerializedBlock } from "../api";

export function editorTargetMatches(routeId: string | undefined, postId: number | null, createdRoute: number | null): boolean {
  return routeId ? Number(routeId) === postId : postId === null || createdRoute === postId;
}
export function editorOwnerMatches(loaded: string, target: string, newTarget: string, postId: number | null, createdRoute: number | null): boolean {
  return loaded === target || (loaded === newTarget && createdRoute !== null && createdRoute === postId);
}

/** The recovery copy contains document data only, never access credentials. */
export function documentRecovery(current: { title: string; content: string; excerpt: string; blocks: SerializedBlock[] | null; footnotes: Footnote[] }, version: number, savedAt = new Date().toISOString()) {
  return { title: current.title, content: current.content, excerpt: current.excerpt, blocks: current.blocks, footnotes: current.footnotes, savedAt, version };
}
