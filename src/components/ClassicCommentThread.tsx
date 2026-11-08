import type { ReactNode } from "react";
import type { Comment } from "../api";
import { commentTypeLabel, isNotification } from "../commentTypes";
import { classicCommentTree, commentDisplayDepth, type ClassicCommentNode } from "../classicCommentTree";

export default function ClassicCommentThread({ comments, displayDate, threaded, maxDepth, canReply, onReply }: {
  comments: Comment[]; displayDate: (date: string | null) => string; threaded: boolean;
  maxDepth: number; canReply: boolean; onReply: (comment: Comment) => void;
}) {
  const roots = classicCommentTree(comments, threaded, maxDepth), rendered = new Map<number, ReactNode>();
  const stack: { node: ClassicCommentNode<Comment>; complete: boolean }[] = roots.map(node => ({ node, complete: false })).reverse();
  while (stack.length) {
    const { node, complete } = stack.pop()!, item = node.comment;
    if (!complete) {
      stack.push({ node, complete: true });
      for (let index = node.children.length - 1; index >= 0; index--) stack.push({ node: node.children[index], complete: false });
      continue;
    }
    rendered.set(item.id, <div className="public-comment-node" key={item.id}>
      <article id={`comment-${item.id}`} className="public-comment">
        {!isNotification(item) && item.avatarUrl && <div className="public-comment-avatar">
          <img src={item.avatarUrl} alt="" width={48} height={48} loading="lazy" referrerPolicy="no-referrer" />
        </div>}
        <div>
          {isNotification(item) ? <p className="comment-notification"><strong>{commentTypeLabel(item)}:</strong>{" "}{item.authorUrl ? <a href={item.authorUrl} rel="external nofollow ugc">{item.authorName}</a> : item.authorName}</p> : <strong>{item.authorName}</strong>}
          <p className="comment-date">{displayDate(item.createdAt)}</p>
          <div dangerouslySetInnerHTML={{ __html: item.content }} />
          {!isNotification(item) && threaded && canReply && node.depth < commentDisplayDepth(maxDepth) - 1 &&
            <button className="button-link public-comment-reply" aria-label={`Reply to ${item.authorName}`} onClick={() => onReply(item)}>Reply</button>}
        </div>
      </article>
      {node.children.length > 0 && <div className="public-comment-children">{node.children.map(child => rendered.get(child.comment.id))}</div>}
    </div>);
  }
  return <>{roots.map(node => rendered.get(node.comment.id))}</>;
}
