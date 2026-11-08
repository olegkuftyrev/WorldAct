import PostTemplateSelect from "../components/PostTemplateSelect";
import {
  ListTableOptions,
  useListTablePreferences,
} from "../components/ScreenOptions";
import { postLink } from "../publicLinks";
import PostBulkEdit, {
  postFormats,
  type Author,
  type PostFormat,
  type PostChanges,
} from "./PostBulkEdit";
import {
  Fragment,
  useContext,
  useEffect,
  useState,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, json, date, type Post, type Term } from "../api";
import {
  Session,
  Icon,
  ScreenTabs,
  Notice,
  ResourceState,
  useResource,
  errorText,
} from "../components/AdminUI";

type ListedPost = Post & {
  commentCount?: number;
  approvedCommentCount?: number;
  pendingCommentCount?: number;
};
type PostResult = {
  posts: ListedPost[];
  counts: Record<string, number>;
  pagination: {
    page: number;
    perPage: number;
    totalPosts: number;
    totalPages: number;
  };
};
const statusNames: Record<Post["status"], string> = {
  publish: "Published",
  draft: "Draft",
  pending: "Pending Review",
  future: "Scheduled",
  private: "Private",
  trash: "Trash",
};
export default function PostList({ type }: { type: "post" | "page" }) {
  const { user } = useContext(Session);
  const tablePreferences = useListTablePreferences(
    type === "post" ? "posts" : "pages",
  );
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "all",
    search = params.get("search") || "",
    page = Math.max(1, Number(params.get("page")) || 1);
  const orderby = params.get("orderby") || "date",
    order = params.get("order") || "desc";
  const category = params.get("category") || "",
    month = params.get("month") || "";
  const label = type === "post" ? "Posts" : "Pages",
    singular = type === "post" ? "Post" : "Page",
    base = `/admin/${type === "post" ? "posts" : "pages"}`;
  const queryParams = new URLSearchParams(params);
  queryParams.set("type", type);
  queryParams.set("status", status);
  queryParams.set("page", String(page));
  queryParams.set("perPage", String(tablePreferences.value.perPage));
  queryParams.set("orderby", orderby);
  queryParams.set("order", order);
  const resource = useResource<PostResult>(`/posts?${queryParams}`);
  const terms = useResource<{ terms: Term[] }>("/terms?taxonomy=category");
  const allTerms = useResource<{ terms: Term[] }>("/terms");
  const authors = useResource<{ authors: Author[] }>("/authors");
  const [query, setQuery] = useState(search),
    [selected, setSelected] = useState<number[]>([]),
    [bulk, setBulk] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<Post | null>(null),
    [bulkEditing, setBulkEditing] = useState(false),
    [filterCategory, setFilterCategory] = useState(category),
    [filterMonth, setFilterMonth] = useState(month);
  useEffect(() => {
    setQuery(search);
    setSelected([]);
    setEditing(null);
    setBulkEditing(false);
    setFilterCategory(category);
    setFilterMonth(month);
  }, [search, status, type, page, category, month]);
  const posts = resource.data?.posts || [],
    pagination = resource.data?.pagination;
  const canPublish = user?.role !== "contributor";
  function change(changes: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes))
      value ? next.set(key, value) : next.delete(key);
    if (!("page" in changes)) next.delete("page");
    setParams(next);
  }
  async function action(ids: number[], operation: string) {
    if (!ids.length || !operation) return;
    if (
      operation === "delete" &&
      !window.confirm(
        "Permanently delete the selected content? This cannot be undone.",
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      for (const id of ids)
        await api(
          `/posts/${id}`,
          operation === "delete"
            ? json("DELETE")
            : json("PUT", { status: operation }),
        );
      setSelected([]);
      setNotice(
        operation === "trash"
          ? "Item moved to the Trash."
          : operation === "delete"
            ? "Item permanently deleted."
            : "Item restored.",
      );
      await resource.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function sort(field: string) {
    change({
      orderby: field,
      order: orderby === field && order === "asc" ? "desc" : "asc",
    });
  }
  const visibleColumnCount =
    2 +
    [
      "author",
      ...(type === "post" ? ["categories", "tags"] : []),
      "comments",
      "date",
    ].filter((column) => !tablePreferences.value.hiddenColumns.includes(column))
      .length;
  const checkAll =
    posts.length > 0 && posts.every((post) => selected.includes(post.id));
  const header = (
    <tr>
      <td className="manage-column column-cb check-column">
        <input
          type="checkbox"
          aria-label="Select all"
          checked={checkAll}
          onChange={(e) =>
            setSelected(e.target.checked ? posts.map((post) => post.id) : [])
          }
        />
      </td>
      <th
        scope="col"
        className="manage-column column-title column-primary"
        aria-sort={
          orderby === "title"
            ? order === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        <button
          className="button-link table-sort"
          onClick={() => sort("title")}
        >
          Title {orderby === "title" && (order === "asc" ? "↑" : "↓")}
        </button>
      </th>
      <th scope="col" className="manage-column column-author">
        Author
      </th>
      {type === "post" && (
        <>
          <th scope="col" className="manage-column column-categories">
            Categories
          </th>
          <th scope="col" className="manage-column column-tags">
            Tags
          </th>
        </>
      )}
      <th scope="col" className="manage-column column-comments">
        <Icon name="admin-comments" />
        <span className="screen-reader-text">Comments</span>
      </th>
      <th
        scope="col"
        className="manage-column column-date"
        aria-sort={
          orderby === "date"
            ? order === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        <button className="button-link table-sort" onClick={() => sort("date")}>
          Date {orderby === "date" && (order === "asc" ? "↑" : "↓")}
        </button>
      </th>
    </tr>
  );
  const pager = (
    <div className="tablenav-pages">
      <span className="displaying-num">
        {pagination?.totalPosts ?? posts.length}{" "}
        {(pagination?.totalPosts ?? posts.length) === 1 ? "item" : "items"}
      </span>
      {pagination && pagination.totalPages > 1 && (
        <span className="pagination-links">
          <button
            className="button"
            aria-label="First page"
            disabled={page <= 1}
            onClick={() => change({ page: "1" })}
          >
            «
          </button>
          <button
            className="button"
            aria-label="Previous page"
            disabled={page <= 1}
            onClick={() => change({ page: String(page - 1) })}
          >
            ‹
          </button>
          <span className="paging-input">
            {" "}
            {page} of{" "}
            <span className="total-pages">{pagination.totalPages}</span>{" "}
          </span>
          <button
            className="button"
            aria-label="Next page"
            disabled={page >= pagination.totalPages}
            onClick={() => change({ page: String(page + 1) })}
          >
            ›
          </button>
          <button
            className="button"
            aria-label="Last page"
            disabled={page >= pagination.totalPages}
            onClick={() => change({ page: String(pagination.totalPages) })}
          >
            »
          </button>
        </span>
      )}
    </div>
  );
  return (
    <>
      <ScreenTabs>
        <ListTableOptions
          table={tablePreferences}
          itemLabel={label.toLowerCase()}
          excerpt
          columns={[
            { id: "author", label: "Author" },
            ...(type === "post"
              ? [
                  { id: "categories", label: "Categories" },
                  { id: "tags", label: "Tags" },
                ]
              : []),
            { id: "comments", label: "Comments" },
            { id: "date", label: "Date" },
          ]}
          onApply={() => change({ page: "1" })}
        />
      </ScreenTabs>
      <main className="wrap worldact-posts">
        <h1 className="wp-heading-inline">{label}</h1>{" "}
        <Link className="page-title-action" to={`${base}/new`}>
          Add New {singular}
        </Link>
        <hr className="wp-header-end" />
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {error && <Notice error>{error}</Notice>}
        <ResourceState
          loading={resource.loading}
          error={resource.error}
          retry={resource.reload}
        />
        <ul className="subsubsub">
          {[
            ["all", "All"],
            ["publish", "Published"],
            ["draft", "Drafts"],
            ["pending", "Pending"],
            ["future", "Scheduled"],
            ["private", "Private"],
            ["trash", "Trash"],
          ]
            .filter(
              ([value]) =>
                ["all", "publish", "draft", "trash"].includes(value) ||
                (resource.data?.counts[value] || 0) > 0 ||
                status === value,
            )
            .map(([value, text], i) => (
              <li key={value}>
                {i > 0 && " | "}
                <button
                  className={`button-link ${status === value ? "current" : ""}`}
                  onClick={() => change({ status: value })}
                >
                  {text}{" "}
                  <span className="count">
                    ({resource.data?.counts[value] || 0})
                  </span>
                </button>
              </li>
            ))}
        </ul>
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            change({ search: query });
          }}
        >
          <label className="screen-reader-text" htmlFor="post-search-input">
            Search {label}
          </label>
          <input
            id="post-search-input"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button className="button">Search {label}</button>
        </form>
        <div className="tablenav top">
          <div className="alignleft actions bulkactions">
            <label
              className="screen-reader-text"
              htmlFor="bulk-action-selector"
            >
              Bulk actions
            </label>
            <select
              id="bulk-action-selector"
              value={bulk}
              onChange={(e) => setBulk(e.target.value)}
            >
              <option value="">Bulk actions</option>
              {status === "trash" ? (
                <>
                  <option value="draft">Restore</option>
                  <option value="delete">Delete permanently</option>
                </>
              ) : (
                <>
                  <option value="edit">Edit</option>
                  <option value="trash">Move to Trash</option>
                </>
              )}
            </select>
            <button
              className="button action"
              onClick={() => {
                if (bulk === "edit") {
                  setBulkEditing(true);
                  setEditing(null);
                } else void action(selected, bulk);
              }}
              disabled={busy || !selected.length || !bulk}
            >
              Apply
            </button>
          </div>
          <form
            className="alignleft actions post-list-filters"
            onSubmit={(e) => {
              e.preventDefault();
              change({ month: filterMonth, category: filterCategory });
            }}
          >
            <label className="screen-reader-text" htmlFor="filter-month">
              Filter by date
            </label>
            <input
              id="filter-month"
              type="month"
              aria-label="Filter by month"
              value={filterMonth}
              onChange={(e) => setFilterMonth(e.target.value)}
            />
            {type === "post" && (
              <>
                <label className="screen-reader-text" htmlFor="filter-category">
                  Filter by category
                </label>
                <select
                  id="filter-category"
                  value={filterCategory}
                  onChange={(e) => setFilterCategory(e.target.value)}
                >
                  <option value="">All Categories</option>
                  {terms.data?.terms.map((term) => (
                    <option key={term.id} value={term.id}>
                      {term.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <button className="button">Filter</button>
            {(category ||
              month ||
              params.has("tag") ||
              params.has("author")) && (
              <button
                type="button"
                className="button-link"
                onClick={() =>
                  change({ month: "", category: "", tag: "", author: "" })
                }
              >
                Clear
              </button>
            )}
          </form>
          {pager}
        </div>
        <table
          data-hidden-columns={tablePreferences.value.hiddenColumns.join(" ")}
          className={`wp-list-table widefat fixed striped table-view-${tablePreferences.value.viewMode} posts`}
        >
          <thead>{header}</thead>
          <tbody>
            {bulkEditing && (
              <tr className="inline-edit-row">
                <td colSpan={visibleColumnCount}>
                  <PostBulkEdit
                    posts={posts.filter((post) => selected.includes(post.id))}
                    type={type}
                    canPublish={canPublish}
                    canSticky={
                      user?.role === "administrator" || user?.role === "editor"
                    }
                    authors={authors.data?.authors || []}
                    authorsError={authors.error}
                    terms={allTerms.data?.terms || []}
                    close={() => setBulkEditing(false)}
                    saved={async (result) => {
                      setBulkEditing(false);
                      setSelected([]);
                      setNotice(
                        `${result.updated.length} ${result.updated.length === 1 ? singular.toLowerCase() : label.toLowerCase()} updated.`,
                      );
                      setError(
                        result.errors
                          .map(
                            (item) =>
                              `${posts.find((post) => post.id === item.id)?.title || `Item #${item.id}`}: ${item.error}`,
                          )
                          .join(" "),
                      );
                      await resource.reload();
                    }}
                  />
                </td>
              </tr>
            )}
            {posts.map((post) => (
              <Fragment key={post.id}>
                <tr hidden={editing?.id === post.id}>
                  <th scope="row" className="check-column">
                    <input
                      type="checkbox"
                      aria-label={`Select ${post.title}`}
                      checked={selected.includes(post.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, post.id]
                            : selected.filter((id) => id !== post.id),
                        )
                      }
                    />
                  </th>
                  <td className="title column-title column-primary">
                    <strong>
                      <Link className="row-title" to={`${base}/${post.id}`}>
                        {post.title || "(no title)"}
                      </Link>
                      {post.status !== "publish" &&
                        ` — ${statusNames[post.status]}`}
                      {post.sticky && " — Sticky"}
                      {post.hasPassword && " — Password protected"}
                    </strong>
                    {tablePreferences.value.viewMode === "excerpt" && (
                      <p className="worldact-list-excerpt">
                        {new DOMParser()
                          .parseFromString(
                            post.excerpt || post.content,
                            "text/html",
                          )
                          .body.textContent?.slice(0, 240) || "No excerpt."}
                      </p>
                    )}
                    <div className="row-actions">
                      {post.status === "trash" ? (
                        <>
                          <button
                            className="button-link"
                            disabled={busy}
                            onClick={() => void action([post.id], "draft")}
                          >
                            Restore
                          </button>{" "}
                          |{" "}
                          <button
                            className="button-link button-link-delete"
                            disabled={busy}
                            onClick={() => void action([post.id], "delete")}
                          >
                            Delete Permanently
                          </button>
                        </>
                      ) : (
                        <>
                          <Link to={`${base}/${post.id}`}>Edit</Link> |{" "}
                          <button
                            className="button-link"
                            onClick={() => {
                              setEditing(post);
                              setBulkEditing(false);
                            }}
                          >
                            Quick Edit
                          </button>{" "}
                          |{" "}
                          <button
                            className="button-link button-link-delete"
                            disabled={busy}
                            onClick={() => void action([post.id], "trash")}
                          >
                            Trash
                          </button>{" "}
                          |{" "}
                          {post.status === "publish" ? (
                            <Link to={postLink(post)}>View</Link>
                          ) : (
                            <Link to={`${base}/${post.id}`}>
                              Continue editing
                            </Link>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                  <td className="author column-author">
                    <button
                      className="button-link"
                      onClick={() => change({ author: String(post.authorId) })}
                    >
                      {post.authorName}
                    </button>
                  </td>
                  {type === "post" && (
                    <>
                      <td className="categories column-categories">
                        {(
                          post.categories ||
                          post.terms?.filter(
                            (term) => term.taxonomy === "category",
                          ) ||
                          []
                        ).map((term, i) => (
                          <Fragment key={term.id}>
                            {i > 0 && ", "}
                            <button
                              className="button-link"
                              onClick={() =>
                                change({ category: String(term.id) })
                              }
                            >
                              {term.name}
                            </button>
                          </Fragment>
                        ))}
                      </td>
                      <td className="tags column-tags">
                        {post.tags?.map((term, i) => (
                          <Fragment key={term.id}>
                            {i > 0 && ", "}
                            <button
                              className="button-link"
                              onClick={() => change({ tag: String(term.id) })}
                            >
                              {term.name}
                            </button>
                          </Fragment>
                        ))}
                        {!post.tags?.length && "—"}
                      </td>
                    </>
                  )}
                  <td className="comments column-comments">
                    <Link
                      className="post-com-count post-com-count-approved"
                      to={`/admin/comments?postId=${post.id}`}
                      aria-label={`${post.commentCount ?? 0} comments on ${post.title}`}
                    >
                      <span className="comment-count-approved">
                        {post.commentCount ?? 0}
                      </span>
                    </Link>
                    {!!post.pendingCommentCount && (
                      <Link
                        className="post-com-count post-com-count-pending"
                        to={`/admin/comments?postId=${post.id}&status=pending`}
                        aria-label={`${post.pendingCommentCount} pending comments on ${post.title}`}
                      >
                        <span className="comment-count-pending">
                          {post.pendingCommentCount}
                        </span>
                      </Link>
                    )}
                  </td>
                  <td className="date column-date">
                    {post.status === "publish"
                      ? "Published"
                      : post.status === "future"
                        ? "Scheduled"
                        : "Last Modified"}
                    <br />
                    {date(
                      post.status === "future"
                        ? post.scheduledAt
                        : post.status === "publish"
                          ? post.publishedAt
                          : post.updatedAt,
                    )}
                  </td>
                </tr>
                {editing?.id === post.id && (
                  <tr className="inline-edit-row">
                    <td colSpan={visibleColumnCount}>
                      <QuickEdit
                        post={editing}
                        canPublish={canPublish}
                        terms={terms.data?.terms || []}
                        authors={authors.data?.authors || []}
                        canSticky={
                          user?.role === "administrator" ||
                          user?.role === "editor"
                        }
                        cancel={() => setEditing(null)}
                        onSave={async (patch) => {
                          await api(
                            `/posts/${post.id}`,
                            json("PUT", { ...patch, version: post.version }),
                          );
                          setEditing(null);
                          setNotice(`${singular} updated.`);
                          await resource.reload();
                        }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!resource.loading && !posts.length && (
              <tr className="no-items">
                <td colSpan={visibleColumnCount}>
                  No {label.toLowerCase()} found.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot>{header}</tfoot>
        </table>
        <div className="tablenav bottom">{pager}</div>
      </main>
    </>
  );
}
function QuickEdit({
  post,
  terms,
  canPublish,
  canSticky,
  authors,
  cancel,
  onSave,
}: {
  post: Post;
  terms: Term[];
  canPublish: boolean;
  canSticky: boolean;
  authors: Author[];
  cancel: () => void;
  onSave: (patch: PostChanges) => Promise<void>;
}) {
  const [title, setTitle] = useState(post.title),
    [slug, setSlug] = useState(post.slug),
    [status, setStatus] = useState(post.status),
    [categories, setCategories] = useState(post.categoryIds || []),
    [sticky, setSticky] = useState(post.sticky),
    [commentStatus, setCommentStatus] = useState(post.commentStatus),
    [pingStatus, setPingStatus] = useState(
      (post as Post & { pingStatus?: "open" | "closed" }).pingStatus ||
        "closed",
    ),
    [authorId, setAuthorId] = useState(post.authorId),
    [format, setFormat] = useState<PostFormat>(post.format || "standard"),
    [templateSlug, setTemplateSlug] = useState(post.templateSlug || ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        title,
        slug,
        status,
        scheduledAt: status === "future" ? post.scheduledAt : null,
        categoryIds: categories,
        ...(canSticky ? { sticky } : {}),
        commentStatus,
        pingStatus,
        authorId,
        templateSlug,
        ...(post.type === "post" ? { format } : {}),
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="quick-edit-form" onSubmit={submit}>
      <h3>Quick Edit</h3>
      {error && <Notice error>{error}</Notice>}
      <div className="quick-edit-fields">
        <fieldset>
          <label>
            Author
            <select
              value={authorId}
              disabled={!authors.length}
              onChange={(event) => setAuthorId(Number(event.target.value))}
            >
              {!authors.some((author) => author.id === authorId) && (
                <option value={authorId}>{post.authorName}</option>
              )}
              {authors.map((author) => (
                <option key={author.id} value={author.id}>
                  {author.displayName} ({author.username})
                </option>
              ))}
            </select>
          </label>
          {post.type === "post" && (
            <label>
              Format
              <select
                value={format}
                onChange={(event) =>
                  setFormat(event.target.value as PostFormat)
                }
              >
                {postFormats.map((value) => (
                  <option key={value} value={value}>
                    {value[0].toUpperCase() + value.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Title
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            Slug
            <input value={slug} onChange={(e) => setSlug(e.target.value)} />
          </label>
        </fieldset>
        {post.type === "post" && (
          <fieldset>
            <legend>Categories</legend>
            {terms.map((term) => (
              <label className="checkbox-label" key={term.id}>
                <input
                  type="checkbox"
                  checked={categories.includes(term.id)}
                  onChange={(e) =>
                    setCategories(
                      e.target.checked
                        ? [...categories, term.id]
                        : categories.filter((id) => id !== term.id),
                    )
                  }
                />{" "}
                {term.name}
              </label>
            ))}
          </fieldset>
        )}
        <fieldset>
          <PostTemplateSelect
            type={post.type}
            value={templateSlug}
            onChange={(value) => setTemplateSlug(value || "")}
          />
          <label>
            Status
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as Post["status"])}
            >
              {(
                [
                  "draft",
                  "pending",
                  ...(canPublish
                    ? ["publish", "private"]
                    : post.status === "private"
                      ? ["private"]
                      : []),
                  ...(post.status === "future" ? ["future"] : []),
                ] as Post["status"][]
              ).map((value) => (
                <option key={value} value={value}>
                  {statusNames[value]}
                </option>
              ))}
            </select>
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={commentStatus !== "closed"}
              onChange={(e) =>
                setCommentStatus(e.target.checked ? "open" : "closed")
              }
            />{" "}
            Allow Comments
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={pingStatus === "open"}
              onChange={(event) =>
                setPingStatus(event.target.checked ? "open" : "closed")
              }
            />
            Allow Pings
          </label>
          {post.type === "post" && canSticky && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={sticky || false}
                onChange={(e) => setSticky(e.target.checked)}
              />{" "}
              Make this post sticky
            </label>
          )}
        </fieldset>
      </div>
      <div className="quick-edit-actions">
        <button type="button" className="button" onClick={cancel}>
          Cancel
        </button>
        <button className="button button-primary" disabled={busy}>
          {busy ? "Updating…" : "Update"}
        </button>
      </div>
    </form>
  );
}
