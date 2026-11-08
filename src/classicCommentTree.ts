type CommentIdentity = { id: number; parentId?: number | null };
export type ClassicCommentNode<T> = { comment: T; depth: number; children: ClassicCommentNode<T>[] };
// Settings validates the source's 1–10 display levels. Historical ancestry is
// independent of this presentation limit and must never become call-stack depth.
export const commentDisplayDepth = (value: number) => Number.isFinite(value) ? Math.max(1, Math.min(10, Math.floor(value))) : 5;

export function classicCommentTree<T extends CommentIdentity>(comments: T[], threaded: boolean, maxDepth: number): ClassicCommentNode<T>[] {
  const roots: T[] = [], children = new Map<number, T[]>(), identities = new Set<number>();
  for (const comment of comments) {
    if (identities.has(comment.id)) continue;
    identities.add(comment.id);
    if (!threaded || comment.parentId == null) roots.push(comment);
    else {
      const siblings = children.get(comment.parentId) || [];
      siblings.push(comment); children.set(comment.parentId, siblings);
    }
  }
  const result: ClassicCommentNode<T>[] = [], visited = new Set<number>(), limit = commentDisplayDepth(maxDepth);
  const stack = roots.map(comment => ({ comment, depth: 0, output: result })).reverse();
  while (stack.length) {
    const { comment, depth, output } = stack.pop()!;
    if (visited.has(comment.id)) continue;
    visited.add(comment.id);
    const node: ClassicCommentNode<T> = { comment, depth, children: [] };
    output.push(node);
    const descendants = threaded ? children.get(comment.id) || [] : [], atLimit = depth >= limit - 1;
    for (let index = descendants.length - 1; index >= 0; index--)
      stack.push({ comment: descendants[index], depth: atLimit ? depth : depth + 1, output: atLimit ? output : node.children });
  }
  return result;
}
