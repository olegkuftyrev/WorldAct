// These descendants render or edit a different entity/template context. Even a
// query item showing the current post must not serve as its owned notes list.
export const footnoteEntityBoundaries = new Set([
  "core/query", "core/post-template", "core/post-content", "core/template-part", "core/block", "core/pattern",
]);

type ScopedBlock = { name: string; innerBlocks?: ScopedBlock[] };
export function findOwnedFootnotes<T extends ScopedBlock>(blocks: T[]): T | null {
  const queue = [...blocks];
  while (queue.length) {
    const block = queue.shift()!;
    if (footnoteEntityBoundaries.has(block.name)) continue;
    if (block.name === "core/footnotes") return block;
    queue.push(...(block.innerBlocks || []) as T[]);
  }
  return null;
}
