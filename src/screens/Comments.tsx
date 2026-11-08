import {
  ListTableOptions,
  useListTablePreferences,
} from "../components/ScreenOptions";
import {
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, date, json, type Comment } from "../api";
import {
  errorText,
  Modal,
  Notice,
  ResourceState,
  ScreenTabs,
  Session,
  useResource,
} from "../components/AdminUI";
import { commentShortcut } from "../commentShortcuts";
import "../comments.css";

type Status = Comment["status"] | "all";
type CommentList = {
  comments: Comment[];
  counts: Partial<Record<Status | "mine", number>>;
  permissions: { bulk: boolean; empty: boolean };
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
  const { user } = useContext(Session);
  const [params, setParams] = useSearchParams();
  const tablePreferences = useListTablePreferences("comments");
  const requestedStatus = params.get("status") as Status;
  const status = statuses.some(([value]) => value === requestedStatus)
    ? requestedStatus
    : "all";
  const mine = params.get("mine") === "true";
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
    perPage: String(tablePreferences.value.perPage),
    orderby,
    order,
  });
  if (mine) query.set("mine", "true");
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
  const [emptyReview, setEmptyReview] = useState<"spam" | "trash" | null>(null);
  const [emptyProgress, setEmptyProgress] = useState(0);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setSearchDraft(search);
    setSelected([]);
    setEditing(null);
  }, [search, status, mine, page, postId]);
  const canBulk = resource.data?.permissions.bulk === true;
  const columnCount = canBulk ? 5 : 4;
  const comments = resource.data?.comments || [];
  const counts = resource.data?.counts || {};
  const totalPages = resource.data?.pagination.totalPages || 1;
  const [currentId, setCurrentId] = useState<number | null>(null);
  const pendingEdge = useRef<"first" | "last" | null>(null);
  const previousIndex = useRef(0);
  const shortcuts =
    user?.commentShortcuts === true && user.role !== "subscriber";
  function highlight(id: number) {
    setCurrentId(id);
    const row = document.getElementById(`comment-${id}`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  }
  useEffect(() => {
    if (!shortcuts || resource.loading) return;
    if (pendingEdge.current && comments.length) {
      highlight(
        comments[pendingEdge.current === "first" ? 0 : comments.length - 1].id,
      );
      pendingEdge.current = null;
    } else if (
      currentId !== null &&
      !comments.some((comment) => comment.id === currentId)
    ) {
      if (comments.length)
        highlight(
          comments[Math.min(previousIndex.current, comments.length - 1)].id,
        );
      else setCurrentId(null);
    }
  }, [resource.data, resource.loading, shortcuts]);
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
                ...(nextStatus === "restore"
                  ? { restore: true }
                  : { status: nextStatus }),
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
  async function emptyComments() {
    if (!emptyReview || busy || !resource.data?.permissions.empty) return;
    setBusy(true);
    setError("");
    setEmptyProgress(0);
    let deleted = 0;
    try {
      let hasMore = true;
      while (hasMore) {
        const result = await api<{ deleted: number; hasMore: boolean }>(
          "/comments/empty",
          json("POST", {
            status: emptyReview,
            ...(Number.isInteger(postId) && postId > 0 ? { postId } : {}),
          }),
        );
        deleted += result.deleted;
        setEmptyProgress(deleted);
        hasMore = result.hasMore;
      }
      setEmptyReview(null);
      setSelected([]);
      setEditing(null);
      setNotice(
        `${deleted} ${emptyReview === "spam" ? "spam" : "trashed"} ${deleted === 1 ? "comment" : "comments"} permanently deleted.`,
      );
    } catch (reason) {
      setError(
        `${errorText(reason)}${deleted ? ` ${deleted} comments were deleted before the error.` : ""}`,
      );
    } finally {
      setBusy(false);
      await resource.reload();
    }
  }
  function begin(comment: Comment, mode: Editing["mode"]) {
    if (
      ["spam", "trash"].includes(comment.status) ||
      !(mode === "reply"
        ? comment.permissions?.reply
        : comment.permissions?.edit)
    )
      return;
    setEditing({ comment, mode });
    setError("");
  }
  function closeEditor() {
    const previous = editing;
    setEditing(null);
    if (previous)
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLButtonElement>(
            `#comment-${previous.comment.id} [data-comment-action="${previous.mode}"]`,
          )
          ?.focus();
      });
  }
  async function saved(message: string) {
    setEditing(null);
    setNotice(message);
    await resource.reload();
  }
  useEffect(() => {
    if (!shortcuts) return;
    function keydown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.repeat ||
        busy ||
        resource.loading ||
        editing ||
        deleting ||
        emptyReview
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest(
          'textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"]',
        ) ||
          (target.closest("button,a") &&
            !target.closest(".comments .row-actions")) ||
          (target.closest("input") &&
            !target.matches('.check-column input[type="checkbox"]')))
      )
        return;
      const key = event.key.toLowerCase();
      if (!event.shiftKey && (key === "j" || key === "k")) {
        if (!comments.length) return;
        event.preventDefault();
        const current = comments.findIndex(
          (comment) => comment.id === currentId,
        );
        const next = current < 0 ? 0 : current + (key === "j" ? 1 : -1);
        if (next >= 0 && next < comments.length) {
          previousIndex.current = next;
          highlight(comments[next].id);
        } else if (
          (key === "j" && page < totalPages) ||
          (key === "k" && page > 1)
        ) {
          pendingEdge.current = key === "j" ? "first" : "last";
          change({ page: String(page + (key === "j" ? 1 : -1)) });
        }
        return;
      }
      if (key === "x" && canBulk) {
        if (event.shiftKey) {
          event.preventDefault();
          setSelected(
            comments.every((comment) => selected.includes(comment.id))
              ? []
              : comments.map((comment) => comment.id),
          );
        } else if (currentId !== null) {
          event.preventDefault();
          setSelected(
            selected.includes(currentId)
              ? selected.filter((id) => id !== currentId)
              : [...selected, currentId],
          );
        }
        return;
      }
      if (event.shiftKey) {
        if (
          !canBulk ||
          !selected.length ||
          !["a", "u", "s", "d", "t", "z"].includes(key)
        )
          return;
        const eligible = comments
          .filter((comment) => selected.includes(comment.id))
          .map((comment) => ({
            comment,
            operation: commentShortcut(comment, key, true),
          }))
          .filter((item) => item.operation);
        if (!eligible.length) return;
        event.preventDefault();
        void action(
          eligible.map((item) => item.comment.id),
          eligible[0].operation!,
        );
        return;
      }
      const comment = comments.find((item) => item.id === currentId);
      if (!comment) return;
      const operation = commentShortcut(comment, key, false);
      if (!operation) return;
      event.preventDefault();
      previousIndex.current = comments.indexOf(comment);
      if (["reply", "quick", "edit"].includes(operation))
        begin(comment, operation as Editing["mode"]);
      else void action([comment.id], operation);
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [
    shortcuts,
    comments,
    currentId,
    selected,
    busy,
    resource.loading,
    editing,
    deleting,
    emptyReview,
    page,
    totalPages,
    canBulk,
  ]);
  const paging = (
    <div className="tablenav-pages comment-pagination">
      <span className="displaying-num">
        {resource.data?.pagination.total || 0}{" "}
        {resource.data?.pagination.total === 1 ? "item" : "items"}
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
      <ScreenTabs>
        <ListTableOptions
          table={tablePreferences}
          itemLabel="comments"
          columns={[
            { id: "author", label: "Author" },
            { id: "response", label: "In response to" },
            { id: "date", label: "Submitted on" },
          ]}
          onApply={() => change({ page: "1" })}
        />
      </ScreenTabs>
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
          {(
            [statuses[0], ["mine", "Mine"], ...statuses.slice(1)] as [
              Status | "mine",
              string,
            ][]
          ).map(([value, label], index) => (
            <li key={value}>
              {index > 0 && " | "}
              <Link
                className={
                  (value === "mine" ? mine : !mine && status === value)
                    ? "current"
                    : ""
                }
                aria-current={
                  (value === "mine" ? mine : !mine && status === value)
                    ? "page"
                    : undefined
                }
                to={`?${new URLSearchParams({ ...Object.fromEntries(params), status: value === "mine" ? "all" : value, mine: value === "mine" ? "true" : "false", page: "1" })}`}
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
          {canBulk && (
            <div className="alignleft actions bulkactions">
              <select
                aria-label="Bulk actions"
                value={bulk}
                onChange={(event) => setBulk(event.target.value)}
              >
                <option value="">Bulk actions</option>
                {["trash", "spam"].includes(status) ? (
                  <>
                    <option value="restore">
                      {status === "spam" ? "Not spam" : "Restore"}
                    </option>
                    <option value="delete">Delete permanently</option>
                  </>
                ) : (
                  <>
                    <option value="approved">Approve</option>
                    <option value="pending">Unapprove</option>
                    <option value="spam">Mark as spam</option>
                    <option value="trash">Move to Trash</option>
                  </>
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
          )}
          {resource.data?.permissions.empty &&
            (status === "spam" || status === "trash") && (
              <button
                className="button empty-comment-action"
                disabled={busy || !(counts[status] || 0)}
                onClick={() => {
                  setEmptyProgress(0);
                  setEmptyReview(status);
                }}
              >
                {status === "spam" ? "Empty Spam" : "Empty Trash"}
              </button>
            )}
          {paging}
        </div>
        <table
          data-hidden-columns={tablePreferences.value.hiddenColumns.join(" ")}
          className="wp-list-table widefat fixed striped comments"
        >
          <thead>
            <tr>
              {canBulk && (
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
              )}
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
                  className={`${comment.status === "pending" ? "unapproved" : ""}${shortcuts && currentId === comment.id ? " vim-current" : ""}`}
                  id={`comment-${comment.id}`}
                  tabIndex={shortcuts ? -1 : undefined}
                >
                  {canBulk && (
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
                  )}
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
                    <CommentActions
                      comment={comment}
                      busy={busy}
                      action={(operation) =>
                        void action([comment.id], operation)
                      }
                      begin={(mode) => begin(comment, mode)}
                    />
                  </td>
                  <td className="column-response">
                    {comment.permissions?.edit ? (
                      <Link to={`/admin/content/${comment.postId}`}>
                        {comment.postTitle}
                      </Link>
                    ) : (
                      <strong>{comment.postTitle}</strong>
                    )}
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
                      <td colSpan={columnCount}>
                        <CommentForm
                          key={`${comment.id}-${editing.mode}`}
                          editing={editing}
                          close={closeEditor}
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
                <td colSpan={columnCount}>No comments found.</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="tablenav bottom">{paging}</div>
        {editing?.mode === "edit" && (
          <Modal title="Edit Comment" close={closeEditor}>
            <p>
              Comment on <strong>{editing.comment.postTitle}</strong>, submitted{" "}
              {date(editing.comment.createdAt)}.
            </p>
            <CommentForm
              key={editing.comment.id}
              editing={editing}
              close={closeEditor}
              saved={saved}
              onConflict={resource.reload}
            />
          </Modal>
        )}
        {emptyReview && (
          <Modal
            title={emptyReview === "spam" ? "Empty Spam" : "Empty Trash"}
            close={() => !busy && setEmptyReview(null)}
          >
            <div className="comment-empty-review">
              <p>
                Permanently delete all{" "}
                {emptyReview === "spam" ? "spam" : "trashed"} comments
                {Number.isInteger(postId) && postId > 0 ? " for this post" : ""}
                ? This cannot be undone.
              </p>
              {search && (
                <p>
                  This includes comments outside the current search results.
                </p>
              )}
              {busy && (
                <p role="status">Deleting comments… {emptyProgress} deleted.</p>
              )}
              {error && <Notice error>{error}</Notice>}
              <div className="comment-form-actions">
                <button
                  className="button"
                  disabled={busy}
                  onClick={() => setEmptyReview(null)}
                >
                  Cancel
                </button>
                <button
                  className="button button-danger"
                  disabled={busy}
                  onClick={() => void emptyComments()}
                >
                  {busy ? "Deleting…" : "Delete all permanently"}
                </button>
              </div>
            </div>
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

function CommentActions({
  comment,
  busy,
  action,
  begin,
}: {
  comment: Comment;
  busy: boolean;
  action: (operation: string) => void;
  begin: (mode: Editing["mode"]) => void;
}) {
  const permissions = comment.permissions;
  const removed = comment.status === "spam" || comment.status === "trash";
  const actions: { key: string; node: ReactNode }[] = [];
  const add = (
    key: string,
    label: string,
    onClick: () => void,
    danger = false,
  ) =>
    actions.push({
      key,
      node: (
        <button
          className={`button-link${danger ? " button-link-delete" : ""}`}
          data-comment-action={key}
          disabled={busy}
          onClick={onClick}
        >
          {label}
        </button>
      ),
    });
  if (removed) {
    if (permissions?.moderate)
      add("restore", comment.status === "spam" ? "Not Spam" : "Restore", () =>
        action("restore"),
      );
    if (permissions?.delete)
      add("delete", "Delete permanently", () => action("delete"), true);
  } else {
    if (permissions?.moderate)
      add(
        "moderate",
        comment.status === "approved" ? "Unapprove" : "Approve",
        () => action(comment.status === "approved" ? "pending" : "approved"),
      );
    if (permissions?.reply) add("reply", "Reply", () => begin("reply"));
    if (permissions?.edit) {
      add("quick", "Quick Edit", () => begin("quick"));
      add("edit", "Edit", () => begin("edit"));
    }
    if (permissions?.moderate) {
      add("spam", "Spam", () => action("spam"));
      add("trash", "Trash", () => action("trash"), true);
    }
  }
  return actions.length ? (
    <div className="row-actions visible">
      {actions.map(({ key, node }, index) => (
        <Fragment key={key}>
          {index > 0 && " | "}
          {node}
        </Fragment>
      ))}
    </div>
  ) : null;
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
    authorEmail: comment.authorEmail || "",
    authorUrl: comment.authorUrl || "",
    content: reply ? "" : comment.content,
    status: reply ? "approved" : comment.status,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [conflict, setConflict] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const contextMenu = useRef(false);
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
    <form
      className="comment-edit-form"
      onSubmit={submit}
      onContextMenu={() => {
        contextMenu.current = true;
      }}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.nativeEvent.isComposing ||
          busy ||
          mode === "edit"
        )
          return;
        if (contextMenu.current) {
          contextMenu.current = false;
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
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
              type="text"
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
