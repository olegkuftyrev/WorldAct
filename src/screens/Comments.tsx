import { Fragment, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, date, json, type Comment } from "../api";
import {
  errorText,
  Modal,
  Notice,
  ResourceState,
  ScreenTabs,
  useResource,
} from "../components/AdminUI";
import "../comments.css";

type Status = Comment["status"] | "all";
type CommentList = {
  comments: Comment[];
  counts: Partial<Record<Status, number>>;
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
};
type Editing = { comment: Comment; mode: "edit" | "quick" | "reply" };
const statuses: [Status, string][] = [
  ["all", "All"],
  ["pending", "Pending"],
  ["approved", "Approved"],
  ["spam", "Spam"],
  ["trash", "Trash"],
];

export default function Comments() {
  const [params, setParams] = useSearchParams();
  const requestedStatus = params.get("status") as Status;
  const status = statuses.some(([value]) => value === requestedStatus)
    ? requestedStatus
    : "all";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const search = params.get("search") || "";
  const orderby = ["date", "author", "post"].includes(
    params.get("orderby") || "",
  )
    ? params.get("orderby")!
    : "date";
  const order = params.get("order") === "asc" ? "asc" : "desc";
  const query = new URLSearchParams({
    status,
    excludeTrashSpam: "true",
    page: String(page),
    perPage: "20",
    orderby,
    order,
  });
  if (search) query.set("search", search);
  const postId = Number(params.get("postId"));
  if (Number.isInteger(postId) && postId > 0)
    query.set("postId", String(postId));
  const resource = useResource<CommentList>(`/comments?${query}`);
  const [searchDraft, setSearchDraft] = useState(search),
    [selected, setSelected] = useState<number[]>([]),
    [bulk, setBulk] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null),
    [deleting, setDeleting] = useState<number[] | null>(null);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const comments = resource.data?.comments || [];
  const counts = resource.data?.counts || {};
  const totalPages = resource.data?.pagination.totalPages || 1;
  function change(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values))
      value ? next.set(key, value) : next.delete(key);
    if (!("page" in values)) next.delete("page");
    setParams(next);
    setSelected([]);
    setEditing(null);
  }
  function sort(key: string) {
    change({
      orderby: key,
      order: orderby === key && order === "asc" ? "desc" : "asc",
    });
  }
  async function action(ids: number[], nextStatus: string) {
    if (!ids.length || !nextStatus) return;
    if (nextStatus === "delete" && deleting !== ids) {
      setDeleting(ids);
      return;
    }
    setBusy(true);
    setError("");
    try {
      for (const id of ids) {
        const comment = comments.find((item) => item.id === id);
        await api(
          `/comments/${id}`,
          nextStatus === "delete"
            ? json("DELETE")
            : json("PUT", {
                status: nextStatus,
                ...(comment?.version ? { version: comment.version } : {}),
              }),
        );
      }
      setSelected([]);
      setDeleting(null);
      setEditing(null);
      setNotice(
        nextStatus === "delete"
          ? "Comment permanently deleted."
          : `${ids.length === 1 ? "Comment" : `${ids.length} comments`} updated.`,
      );
      await resource.reload();
    } catch (error) {
      setError(errorText(error));
      await resource.reload();
    } finally {
      setBusy(false);
    }
  }
  function begin(comment: Comment, mode: Editing["mode"]) {
    setEditing({ comment, mode });
    setError("");
  }
  async function saved(message: string) {
    setEditing(null);
    setNotice(message);
    await resource.reload();
  }
  const paging = (
    <div className="tablenav-pages comment-pagination">
      <span className="displaying-num">
        {resource.data?.pagination.total || 0} items
      </span>
      <button
        className="button"
        aria-label="First page"
        disabled={page <= 1 || resource.loading}
        onClick={() => change({ page: "1" })}
      >
        «
      </button>
      <button
        className="button"
        aria-label="Previous page"
        disabled={page <= 1 || resource.loading}
        onClick={() => change({ page: String(page - 1) })}
      >
        ‹
      </button>
      <span>
        {page} of {totalPages}
      </span>
      <button
        className="button"
        aria-label="Next page"
        disabled={page >= totalPages || resource.loading}
        onClick={() => change({ page: String(page + 1) })}
      >
        ›
      </button>
      <button
        className="button"
        aria-label="Last page"
        disabled={page >= totalPages || resource.loading}
        onClick={() => change({ page: String(totalPages) })}
      >
        »
      </button>
    </div>
  );
  return (
    <>
      <ScreenTabs />
      <main className="wrap worldact-comments">
        <h1>Comments</h1>
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {error && <Notice error>{error}</Notice>}
        <ResourceState
          loading={resource.loading}
          error={resource.error}
          retry={resource.reload}
        />
        <ul className="subsubsub">
          {statuses.map(([value, label], index) => (
            <li key={value}>
              {index > 0 && " | "}
              <Link
                className={status === value ? "current" : ""}
                aria-current={status === value ? "page" : undefined}
                to={`?${new URLSearchParams({ ...Object.fromEntries(params), status: value, page: "1" })}`}
              >
                {label}{" "}
                <span className="count">
                  (
                  {value === "all"
                    ? (counts.approved || 0) + (counts.pending || 0)
                    : counts[value] || 0}
                  )
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <form
          className="search-box"
          onSubmit={(event) => {
            event.preventDefault();
            change({ search: searchDraft });
          }}
        >
          <input
            type="search"
            aria-label="Search comments"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            maxLength={300}
          />
          <button className="button">Search Comments</button>
        </form>
        <div className="tablenav top">
          <div className="alignleft actions bulkactions">
            <select
              aria-label="Bulk actions"
              value={bulk}
              onChange={(event) => setBulk(event.target.value)}
            >
              <option value="">Bulk actions</option>
              <option value="approved">Approve</option>
              <option value="pending">Unapprove</option>
              <option value="spam">Mark as spam</option>
              <option value="trash">Move to Trash</option>
              {["trash", "spam"].includes(status) && (
                <option value="delete">Delete permanently</option>
              )}
            </select>
            <button
              className="button"
              disabled={busy || !selected.length || !bulk}
              onClick={() => void action(selected, bulk)}
            >
              Apply
            </button>
          </div>
          {paging}
        </div>
        <table className="wp-list-table widefat fixed striped comments">
          <thead>
            <tr>
              <td className="check-column">
                <input
                  type="checkbox"
                  aria-label="Select all comments"
                  checked={
                    comments.length > 0 &&
                    comments.every((item) => selected.includes(item.id))
                  }
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? comments.map((item) => item.id)
                        : [],
                    )
                  }
                />
              </td>
              <th
                className="column-author"
                aria-sort={
                  orderby === "author"
                    ? order === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                }
              >
                <button className="button-link" onClick={() => sort("author")}>
                  Author {orderby === "author" && (order === "asc" ? "↑" : "↓")}
                </button>
              </th>
              <th>Comment</th>
              <th className="column-response">
                <button className="button-link" onClick={() => sort("post")}>
                  In response to{" "}
                  {orderby === "post" && (order === "asc" ? "↑" : "↓")}
                </button>
              </th>
              <th className="column-date">
                <button className="button-link" onClick={() => sort("date")}>
                  Submitted on{" "}
                  {orderby === "date" && (order === "asc" ? "↑" : "↓")}
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {comments.map((comment) => (
              <Fragment key={comment.id}>
                <tr
                  className={comment.status === "pending" ? "unapproved" : ""}
                  id={`comment-${comment.id}`}
                >
                  <th scope="row" className="check-column">
                    <input
                      type="checkbox"
                      aria-label={`Select comment by ${comment.authorName}`}
                      checked={selected.includes(comment.id)}
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? [...selected, comment.id]
                            : selected.filter((id) => id !== comment.id),
                        )
                      }
                    />
                  </th>
                  <td className="author">
                    <strong>{comment.authorName}</strong>
                    {comment.authorUrl && (
                      <>
                        <br />
                        <a
                          href={comment.authorUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {comment.authorUrl.replace(/^https?:\/\//, "")}
                        </a>
                      </>
                    )}
                    {comment.authorEmail && (
                      <>
                        <br />
                        <a href={`mailto:${comment.authorEmail}`}>
                          {comment.authorEmail}
                        </a>
                      </>
                    )}
                  </td>
                  <td className="comment column-comment">
                    <strong className="comment-mobile-author">
                      {comment.authorName}
                    </strong>
                    {comment.parentId && (
                      <p className="description">
                        In reply to comment #{comment.parentId}
                      </p>
                    )}
                    <div
                      className="comment-content"
                      dangerouslySetInnerHTML={{ __html: comment.content }}
                    />
                    <div className="row-actions visible">
                      <button
                        className="button-link"
                        disabled={busy}
                        onClick={() =>
                          void action(
                            [comment.id],
                            comment.status === "approved"
                              ? "pending"
                              : "approved",
                          )
                        }
                      >
                        {comment.status === "approved"
                          ? "Unapprove"
                          : "Approve"}
                      </button>
                      {" | "}
                      <button
                        className="button-link"
                        onClick={() => begin(comment, "reply")}
                      >
                        Reply
                      </button>
                      {" | "}
                      <button
                        className="button-link"
                        onClick={() => begin(comment, "quick")}
                      >
                        Quick Edit
                      </button>
                      {" | "}
                      <button
                        className="button-link"
                        onClick={() => begin(comment, "edit")}
                      >
                        Edit
                      </button>
                      {" | "}
                      {comment.status !== "spam" && (
                        <>
                          <button
                            className="button-link"
                            disabled={busy}
                            onClick={() => void action([comment.id], "spam")}
                          >
                            Spam
                          </button>
                          {" | "}
                        </>
                      )}
                      {comment.status === "trash" ||
                      comment.status === "spam" ? (
                        <>
                          <button
                            className="button-link"
                            disabled={busy}
                            onClick={() => void action([comment.id], "pending")}
                          >
                            Restore
                          </button>
                          {" | "}
                          <button
                            className="button-link button-link-delete"
                            disabled={busy}
                            onClick={() => setDeleting([comment.id])}
                          >
                            Delete permanently
                          </button>
                        </>
                      ) : (
                        <button
                          className="button-link button-link-delete"
                          disabled={busy}
                          onClick={() => void action([comment.id], "trash")}
                        >
                          Trash
                        </button>
                      )}
                    </div>
                  </td>
                  <td className="column-response">
                    <Link to={`/admin/posts/${comment.postId}`}>
                      {comment.postTitle}
                    </Link>
                    <br />
                    <Link to={`?postId=${comment.postId}`}>
                      View all comments for this post
                    </Link>
                  </td>
                  <td className="column-date">
                    {date(comment.createdAt)}
                    <br />
                    <span className={`comment-status status-${comment.status}`}>
                      {comment.status}
                    </span>
                  </td>
                </tr>
                {editing?.comment.id === comment.id &&
                  editing.mode !== "edit" && (
                    <tr className="comment-inline-row">
                      <td colSpan={5}>
                        <CommentForm
                          key={`${comment.id}-${editing.mode}`}
                          editing={editing}
                          close={() => setEditing(null)}
                          saved={saved}
                          onConflict={resource.reload}
                        />
                      </td>
                    </tr>
                  )}
              </Fragment>
            ))}
            {!resource.loading && !comments.length && (
              <tr>
                <td colSpan={5}>No comments found.</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="tablenav bottom">{paging}</div>
        {editing?.mode === "edit" && (
          <Modal title="Edit Comment" close={() => setEditing(null)}>
            <p>
              Comment on <strong>{editing.comment.postTitle}</strong>, submitted{" "}
              {date(editing.comment.createdAt)}.
            </p>
            <CommentForm
              key={editing.comment.id}
              editing={editing}
              close={() => setEditing(null)}
              saved={saved}
              onConflict={resource.reload}
            />
          </Modal>
        )}
        {deleting && (
          <Modal
            title="Delete Comments"
            close={() => !busy && setDeleting(null)}
          >
            <p>
              Permanently delete{" "}
              {deleting.length === 1
                ? "this comment"
                : `these ${deleting.length} comments`}
              ? This cannot be undone.
            </p>
            <div className="comment-form-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => setDeleting(null)}
              >
                Cancel
              </button>
              <button
                className="button button-danger"
                disabled={busy}
                onClick={() => void action(deleting, "delete")}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </Modal>
        )}
      </main>
    </>
  );
}

function CommentForm({
  editing,
  close,
  saved,
  onConflict,
}: {
  editing: Editing;
  close: () => void;
  saved: (message: string) => Promise<void>;
  onConflict: () => Promise<void>;
}) {
  const { comment, mode } = editing;
  const reply = mode === "reply";
  const [form, setForm] = useState({
    authorName: comment.authorName,
    authorEmail: comment.authorEmail,
    authorUrl: comment.authorUrl || "",
    content: reply ? "" : comment.content,
    status: reply ? "approved" : comment.status,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  function wrap(start: string, end: string) {
    const area = textarea.current;
    if (!area) return;
    const from = area.selectionStart,
      to = area.selectionEnd;
    setForm((current) => ({
      ...current,
      content: `${current.content.slice(0, from)}${start}${current.content.slice(from, to)}${end}${current.content.slice(to)}`,
    }));
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(from + start.length, to + start.length);
    });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    setConflict(false);
    try {
      await api(
        reply ? "/comments" : `/comments/${comment.id}`,
        json(
          reply ? "POST" : "PUT",
          reply
            ? {
                postId: comment.postId,
                parentId: comment.id,
                content: form.content,
                status: form.status,
              }
            : {
                ...form,
                ...(comment.version ? { version: comment.version } : {}),
              },
        ),
      );
      await saved(reply ? "Reply added." : "Comment updated.");
    } catch (error) {
      setError(errorText(error));
      const changed = error instanceof ApiError && error.status === 409;
      setConflict(changed);
      if (changed) await onConflict();
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="comment-edit-form" onSubmit={submit}>
      <h2>
        {reply
          ? `Reply to ${comment.authorName}`
          : mode === "quick"
            ? "Quick Edit"
            : "Author"}
      </h2>
      {error && (
        <Notice error>
          {error}
          {conflict && (
            <>
              <br />
              Your text is preserved below. Copy any changes you want to keep,
              then cancel and reopen this comment to load its latest version.
            </>
          )}
        </Notice>
      )}
      {!reply && (
        <div className="comment-author-fields">
          <label>
            Name
            <input
              required
              maxLength={160}
              value={form.authorName}
              onChange={(event) =>
                setForm({ ...form, authorName: event.target.value })
              }
            />
          </label>
          <label>
            Email
            <input
              type="email"
              maxLength={254}
              value={form.authorEmail}
              onChange={(event) =>
                setForm({ ...form, authorEmail: event.target.value })
              }
            />
          </label>
          <label>
            URL
            <input
              type="url"
              maxLength={2000}
              placeholder="https://"
              value={form.authorUrl}
              onChange={(event) =>
                setForm({ ...form, authorUrl: event.target.value })
              }
            />
          </label>
        </div>
      )}
      <label
        className="comment-content-label"
        htmlFor={`comment-content-${comment.id}`}
      >
        {reply ? "Reply" : "Comment"}
      </label>
      <div
        className="comment-quicktags"
        role="toolbar"
        aria-label="Comment formatting"
      >
        <button
          type="button"
          className="button"
          aria-label="Bold"
          onClick={() => wrap("<strong>", "</strong>")}
        >
          <strong>b</strong>
        </button>
        <button
          type="button"
          className="button"
          aria-label="Italic"
          onClick={() => wrap("<em>", "</em>")}
        >
          <em>i</em>
        </button>
        <button
          type="button"
          className="button"
          onClick={() => wrap("<blockquote>", "</blockquote>")}
        >
          b-quote
        </button>
        <button
          type="button"
          className="button"
          onClick={() => wrap("<code>", "</code>")}
        >
          code
        </button>
      </div>
      <textarea
        ref={textarea}
        id={`comment-content-${comment.id}`}
        autoFocus
        required
        rows={reply ? 5 : 7}
        maxLength={20000}
        value={form.content}
        onChange={(event) => setForm({ ...form, content: event.target.value })}
      />
      <p className="description">
        Basic HTML formatting is allowed. Unsupported HTML is removed when
        saved.
      </p>
      <div className="comment-form-actions">
        <label>
          Status{" "}
          <select
            value={form.status}
            onChange={(event) =>
              setForm({
                ...form,
                status: event.target.value as Comment["status"],
              })
            }
          >
            <option value="approved">Approved</option>
            <option value="pending">Pending</option>
            {!reply && (
              <>
                <option value="spam">Spam</option>
                <option value="trash">Trash</option>
              </>
            )}
          </select>
        </label>
        <span className="comment-form-buttons">
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button className="button button-primary" disabled={busy || conflict}>
            {busy ? "Saving…" : reply ? "Reply" : "Update Comment"}
          </button>
        </span>
      </div>
    </form>
  );
}
