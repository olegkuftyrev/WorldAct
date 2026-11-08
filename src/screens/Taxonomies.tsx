import "../taxonomies.css";
import {
  ListTableOptions,
  useListTablePreferences,
} from "../components/ScreenOptions";
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, json, type Term } from "../api";
import {
  Session,
  ScreenTabs,
  Notice,
  ResourceState,
  useResource,
  errorText,
} from "../components/AdminUI";

type ListedTerm = Term & { contextOnly?: boolean; depth?: number };
type TermPage = {
  terms: ListedTerm[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
};

export default function Taxonomies({
  taxonomy,
}: {
  taxonomy: "category" | "tag";
}) {
  const { user } = useContext(Session);
  const [params, setParams] = useSearchParams();
  const tablePreferences = useListTablePreferences(
    taxonomy === "category" ? "categories" : "tags",
  );
  const search = params.get("search") || "";
  const explicitOrderby = ["name", "slug", "description", "count"].includes(
    params.get("orderby") || "",
  )
    ? params.get("orderby")!
    : null;
  const orderby = explicitOrderby || "name";
  const hierarchical = taxonomy === "category" && !explicitOrderby && !search;
  const order = params.get("order") === "desc" ? "desc" : "asc";
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1));
  function change(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values))
      value ? next.set(key, value) : next.delete(key);
    if (!("page" in values)) next.delete("page");
    setParams(next);
    setSelected([]);
    setQuickEditing(null);
  }
  function sort(field: string) {
    change({
      orderby: field,
      order: orderby === field && order === "asc" ? "desc" : "asc",
    });
  }

  const tableQuery = new URLSearchParams({
    taxonomy,
    page: String(page),
    perPage: String(tablePreferences.value.perPage),
    order,
  });
  if (explicitOrderby) tableQuery.set("orderby", explicitOrderby);
  if (search) tableQuery.set("search", search);
  const resource = useTaxonomyPage(
    tablePreferences.loading ? null : `/terms?${tableQuery}`,
  );
  const allTerms = useResource<{ terms: Term[] }>(
    `/terms?taxonomy=${taxonomy}`,
  );
  const requestedEdit = Number(params.get("edit"));
  const editId =
    Number.isInteger(requestedEdit) && requestedEdit > 0 ? requestedEdit : null;
  const editedTerm = useResource<{ term: Term }>(
    editId ? `/terms/${editId}` : null,
  );
  const [quickEditing, setQuickEditing] = useState<Term | null>(null);
  const [editing, setEditing] = useState<Term | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [query, setQuery] = useState(search);
  const [selected, setSelected] = useState<number[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const label = taxonomy === "category" ? "Categories" : "Tags";
  const singular = taxonomy === "category" ? "Category" : "Tag";
  const canManage = user?.role === "administrator" || user?.role === "editor";
  const terms = allTerms.data?.terms || [];
  const visible = resource.data?.terms || [];
  const pagination = resource.data?.pagination;
  const totalPages = pagination?.totalPages || 1;
  const currentPage = pagination?.page || page;
  const total = pagination?.total || 0;
  const selectable = visible.filter(
    (term) => !term.contextOnly && !term.isDefault,
  );
  const defaultCategory = terms.find((term) => term.isDefault);
  const parentChoices = hierarchyTerms(terms);
  useEffect(() => {
    if (
      !tablePreferences.loading &&
      !resource.loading &&
      pagination &&
      pagination.page === page &&
      pagination.perPage === tablePreferences.value.perPage &&
      page > pagination.totalPages
    )
      change({ page: String(pagination.totalPages) });
  }, [
    tablePreferences.loading,
    tablePreferences.value.perPage,
    resource.loading,
    pagination,
    page,
  ]);
  const visibleColumnCount =
    2 +
    ["description", "slug", "posts"].filter(
      (column) => !tablePreferences.value.hiddenColumns.includes(column),
    ).length;
  const pager = (
    <div className="tablenav-pages">
      <span className="displaying-num">
        {total} {total === 1 ? "item" : "items"}
      </span>
      {totalPages > 1 && (
        <span className="pagination-links">
          <button
            className="button"
            aria-label="Previous page"
            disabled={currentPage <= 1 || resource.loading}
            onClick={() => change({ page: String(currentPage - 1) })}
          >
            ‹
          </button>
          <span>
            {currentPage} of {totalPages}
          </span>
          <button
            className="button"
            aria-label="Next page"
            disabled={currentPage >= totalPages || resource.loading}
            onClick={() => change({ page: String(currentPage + 1) })}
          >
            ›
          </button>
        </span>
      )}
    </div>
  );
  useEffect(() => {
    setQuery(search);
    setSelected([]);
    setQuickEditing(null);
  }, [
    search,
    taxonomy,
    page,
    explicitOrderby,
    order,
    tablePreferences.value.perPage,
  ]);
  function clearForm() {
    setEditing(null);
    setName("");
    setSlug("");
    setDescription("");
    setParentId("");
  }
  function reset() {
    clearForm();
    const next = new URLSearchParams(params);
    next.delete("edit");
    setParams(next);
  }
  useEffect(() => {
    clearForm();
    setError("");
  }, [editId, taxonomy]);
  useEffect(() => {
    const term = editedTerm.data?.term;
    if (!editId || term?.id !== editId) return;
    if (term.taxonomy !== taxonomy) {
      setError(`This term belongs to a different taxonomy.`);
      return;
    }
    setEditing(term);
    setName(term.name);
    setSlug(term.slug);
    setDescription(term.description);
    setParentId(term.parentId ? String(term.parentId) : "");
    document.getElementById("term-name")?.focus();
  }, [editedTerm.data, editId, taxonomy]);
  useEffect(() => {
    setQuickEditing(null);
    setSelected([]);
    setError("");
    setNotice("");
  }, [taxonomy]);
  function edit(term: Term) {
    setQuickEditing(null);
    const next = new URLSearchParams(params);
    next.set("edit", String(term.id));
    setParams(next);
    setError("");
  }
  function descendantOf(term: Term, id: number): boolean {
    const visited = new Set<number>();
    let parent = term.parentId;
    while (parent && !visited.has(parent)) {
      if (parent === id) return true;
      visited.add(parent);
      parent =
        terms.find((candidate) => candidate.id === parent)?.parentId || null;
    }
    return term.id === id;
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(
        editing ? `/terms/${editing.id}` : "/terms",
        json(editing ? "PUT" : "POST", {
          taxonomy,
          name,
          slug,
          description,
          parentId: parentId ? Number(parentId) : null,
        }),
      );
      setNotice(`${singular} ${editing ? "updated" : "added"}.`);
      reset();
      await Promise.all([resource.reload(), allTerms.reload()]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(ids: number[]) {
    if (
      !ids.length ||
      !window.confirm(
        `Delete ${ids.length === 1 ? "this " + singular.toLowerCase() : "these " + label.toLowerCase()}? Posts will not be deleted.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      for (const id of ids) await api(`/terms/${id}`, json("DELETE"));
      if (editing && ids.includes(editing.id)) reset();
      setSelected([]);
      setNotice(`${ids.length === 1 ? singular : label} deleted.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      await Promise.all([resource.reload(), allTerms.reload()]);
      setBusy(false);
    }
  }
  const header = (
    <tr>
      <td className="manage-column column-cb check-column">
        <input
          type="checkbox"
          aria-label={`Select all ${label.toLowerCase()}`}
          checked={
            selectable.length > 0 &&
            selectable.every((term) => selected.includes(term.id))
          }
          onChange={(e) =>
            setSelected(
              e.target.checked ? selectable.map((term) => term.id) : [],
            )
          }
          disabled={!selectable.length || resource.loading}
        />
      </td>
      {[
        { id: "name", label: "Name", className: "column-primary" },
        {
          id: "description",
          label: "Description",
          className: "column-description",
        },
        { id: "slug", label: "Slug", className: "column-slug" },
        { id: "count", label: "Count", className: "column-posts" },
      ].map((column) => (
        <th
          key={column.id}
          scope="col"
          className={column.className}
          aria-sort={
            orderby === column.id
              ? order === "asc"
                ? "ascending"
                : "descending"
              : "none"
          }
        >
          <button className="button-link" onClick={() => sort(column.id)}>
            {column.label}{" "}
            {orderby === column.id && (order === "asc" ? "↑" : "↓")}
          </button>
        </th>
      ))}
    </tr>
  );
  return (
    <>
      <ScreenTabs>
        <ListTableOptions
          table={tablePreferences}
          itemLabel={label.toLowerCase()}
          columns={[
            { id: "description", label: "Description" },
            { id: "slug", label: "Slug" },
            { id: "posts", label: "Count" },
          ]}
          onApply={() => change({ page: "1" })}
        />
      </ScreenTabs>
      <main className="wrap taxonomy-wrap">
        <h1>{label}</h1>
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        {error && <Notice error>{error}</Notice>}
        <ResourceState
          loading={tablePreferences.loading || resource.loading}
          error={resource.error}
          retry={resource.reload}
        />
        {!canManage ? (
          <Notice error>
            You do not have permission to manage {label.toLowerCase()}.
          </Notice>
        ) : (
          <div className="taxonomy-columns">
            <section
              className="taxonomy-form"
              aria-label={`${editId ? "Edit" : "Add new"} ${singular.toLowerCase()}`}
            >
              <h2>{editId ? `Edit ${singular}` : `Add New ${singular}`}</h2>
              {editId && (
                <ResourceState
                  loading={editedTerm.loading}
                  error={editedTerm.error}
                  retry={editedTerm.reload}
                />
              )}
              <form onSubmit={save}>
                <div className="form-field">
                  <label htmlFor="term-name">Name</label>
                  <input
                    disabled={!!editId && !editing}
                    id="term-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={200}
                  />
                  <p>The name is how it appears on your site.</p>
                </div>
                <div className="form-field">
                  <label htmlFor="term-slug">Slug</label>
                  <input
                    id="term-slug"
                    type="text"
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                  />
                  <p>
                    The “slug” is the URL-friendly version of the name. It is
                    usually all lowercase and contains only letters, numbers,
                    and hyphens.
                  </p>
                </div>
                {taxonomy === "category" && (
                  <div className="form-field">
                    <label htmlFor="term-parent">Parent Category</label>
                    <select
                      disabled={allTerms.loading || !!allTerms.error}
                      id="term-parent"
                      value={parentId}
                      onChange={(e) => setParentId(e.target.value)}
                    >
                      <option value="">None</option>
                      {parentChoices
                        .filter(
                          (term) => !editing || !descendantOf(term, editing.id),
                        )
                        .map((term) => (
                          <option key={term.id} value={term.id}>
                            {"— ".repeat(Math.min(term.depth, 30))}
                            {term.name}
                          </option>
                        ))}
                    </select>
                    <p>Categories, unlike tags, can have a hierarchy.</p>
                    <ResourceState
                      loading={allTerms.loading}
                      error={allTerms.error}
                      retry={allTerms.reload}
                    />
                  </div>
                )}
                <div className="form-field">
                  <label htmlFor="term-description">Description</label>
                  <textarea
                    id="term-description"
                    rows={5}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                  <p>
                    The description appears in your category or tag archive.
                  </p>
                </div>
                <p className="submit">
                  <button
                    className="button button-primary"
                    disabled={busy || (!!editId && !editing)}
                  >
                    {busy
                      ? "Saving…"
                      : editing
                        ? "Update"
                        : `Add New ${singular}`}
                  </button>
                  {editId && (
                    <button
                      type="button"
                      className="button taxonomy-cancel"
                      onClick={reset}
                    >
                      Cancel
                    </button>
                  )}
                </p>
              </form>
            </section>
            <section className="taxonomy-list" aria-label={label}>
              <form
                className="search-box"
                onSubmit={(e) => {
                  e.preventDefault();
                  change({ search: query });
                }}
              >
                <label className="screen-reader-text" htmlFor="term-search">
                  Search {label}
                </label>
                <input
                  id="term-search"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button className="button">Search {label}</button>
              </form>
              <div className="tablenav top">
                <div className="alignleft actions">
                  <button
                    className="button action"
                    disabled={busy || resource.loading || !selected.length}
                    onClick={() => void remove(selected)}
                  >
                    Delete selected
                  </button>
                </div>
                {pager}
              </div>
              <table
                data-hidden-columns={tablePreferences.value.hiddenColumns.join(
                  " ",
                )}
                className="wp-list-table widefat fixed striped table-view-list tags"
              >
                <thead>{header}</thead>
                <tbody>
                  {visible.map((term) => (
                    <Fragment key={term.id}>
                      <tr
                        hidden={quickEditing?.id === term.id}
                        className={
                          term.contextOnly ? "taxonomy-context-row" : ""
                        }
                      >
                        <th scope="row" className="check-column">
                          <input
                            type="checkbox"
                            aria-label={`Select ${term.name}`}
                            disabled={!!term.isDefault || !!term.contextOnly}
                            checked={selected.includes(term.id)}
                            onChange={(e) =>
                              setSelected(
                                e.target.checked
                                  ? [...selected, term.id]
                                  : selected.filter((id) => id !== term.id),
                              )
                            }
                          />
                        </th>
                        <td className="column-primary">
                          <strong>
                            {term.contextOnly ? (
                              <span className="row-title">
                                {"— ".repeat(term.depth || 0)}
                                {term.name}
                                <span className="screen-reader-text">
                                  {" "}
                                  (parent category repeated for context)
                                </span>
                              </span>
                            ) : (
                              <button
                                className="row-title button-link"
                                onClick={() => edit(term)}
                              >
                                {"— ".repeat(
                                  hierarchical
                                    ? (term.depth ?? termDepth(term, terms))
                                    : 0,
                                )}
                                {term.name}
                              </button>
                            )}
                          </strong>
                          {!term.contextOnly && (
                            <div className="row-actions">
                              <button
                                className="button-link"
                                onClick={() => edit(term)}
                              >
                                Edit
                              </button>{" "}
                              |{" "}
                              <button
                                className="button-link"
                                onClick={() => setQuickEditing(term)}
                              >
                                Quick Edit
                              </button>
                              {!term.isDefault && (
                                <>
                                  {" "}
                                  |{" "}
                                  <button
                                    className="button-link button-link-delete"
                                    disabled={busy}
                                    onClick={() => void remove([term.id])}
                                  >
                                    Delete
                                  </button>
                                </>
                              )}{" "}
                              |{" "}
                              <Link
                                to={`/?${taxonomy}=${encodeURIComponent(term.slug)}`}
                              >
                                View
                              </Link>
                            </div>
                          )}
                        </td>
                        <td
                          className="column-description"
                          data-colname="Description"
                        >
                          {term.description || "—"}
                        </td>
                        <td className="column-slug" data-colname="Slug">
                          {term.slug}
                        </td>
                        <td className="column-posts" data-colname="Count">
                          <Link to={`/admin/posts?${taxonomy}=${term.id}`}>
                            {term.count}
                          </Link>
                        </td>
                      </tr>
                      {!term.contextOnly && quickEditing?.id === term.id && (
                        <tr className="inline-edit-row">
                          <td colSpan={visibleColumnCount}>
                            <TermQuickEdit
                              term={quickEditing}
                              cancel={() => setQuickEditing(null)}
                              save={async (name, slug) => {
                                await api(
                                  `/terms/${term.id}`,
                                  json("PUT", { name, slug }),
                                );
                                setQuickEditing(null);
                                setNotice(`${singular} updated.`);
                                await Promise.all([
                                  resource.reload(),
                                  allTerms.reload(),
                                ]);
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                  {!tablePreferences.loading &&
                    !resource.loading &&
                    !visible.length && (
                      <tr>
                        <td colSpan={visibleColumnCount}>
                          No {label.toLowerCase()} found.
                        </td>
                      </tr>
                    )}
                </tbody>
                <tfoot>{header}</tfoot>
              </table>
              <div className="tablenav bottom">{pager}</div>
              {taxonomy === "category" && (
                <p className="description">
                  Deleting a category does not delete the posts in that
                  category. Posts without a category are assigned to the
                  configured default category
                  {defaultCategory ? `, ${defaultCategory.name}` : ""}.
                </p>
              )}
            </section>
          </div>
        )}
      </main>
    </>
  );
}

// Keep page metadata attached to the exact request that produced it. A URL or
// per-page change must not normalize against a previous response's totalPages.
function useTaxonomyPage(path: string | null) {
  const [state, setState] = useState<{
    path: string | null;
    data?: TermPage;
    loading: boolean;
    error: string;
  }>({ path: null, loading: false, error: "" });
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const request = ++generation.current;
    if (!path) {
      setState({ path: null, loading: false, error: "" });
      return;
    }
    setState((previous) =>
      previous.path === path
        ? { ...previous, loading: true, error: "" }
        : { path, loading: true, error: "" },
    );
    try {
      const data = await api<TermPage>(path);
      if (request === generation.current)
        setState({ path, data, loading: false, error: "" });
    } catch (reason) {
      if (request === generation.current)
        setState((previous) => ({
          ...previous,
          path,
          loading: false,
          error: errorText(reason),
        }));
    }
  }, [path]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  const current = path !== null && state.path === path;
  return {
    data: current ? state.data : undefined,
    loading: path !== null && (!current || state.loading),
    error: current ? state.error : "",
    reload,
  };
}

function TermQuickEdit({
  term,
  cancel,
  save,
}: {
  term: Term;
  cancel: () => void;
  save: (name: string, slug: string) => Promise<void>;
}) {
  const [name, setName] = useState(term.name),
    [slug, setSlug] = useState(term.slug),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      className="worldact-term-quick-edit"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          cancel();
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError("");
        try {
          await save(name, slug);
        } catch (reason) {
          setError(errorText(reason));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2>Quick Edit</h2>
      {error && <Notice error>{error}</Notice>}
      <label>
        Name
        <input
          autoFocus
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label>
        Slug
        <input
          maxLength={220}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
        />
      </label>
      <div className="comment-form-buttons">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={cancel}
        >
          Cancel
        </button>
        <button className="button button-primary" disabled={busy}>
          {busy ? "Saving…" : "Update"}
        </button>
      </div>
    </form>
  );
}

function termDepth(term: Term, terms: Term[]): number {
  let parent = term.parentId,
    depth = 0;
  const seen = new Set<number>([term.id]);
  while (parent && !seen.has(parent) && depth < 30) {
    seen.add(parent);
    depth++;
    parent = terms.find((item) => item.id === parent)?.parentId || null;
  }
  return depth;
}

function hierarchyTerms(terms: Term[]): (Term & { depth: number })[] {
  const ids = new Set(terms.map((term) => term.id));
  const children = new Map<number | null, Term[]>();
  for (const term of terms) {
    const parent =
      term.parentId && ids.has(term.parentId) ? term.parentId : null;
    const siblings = children.get(parent) || [];
    siblings.push(term);
    children.set(parent, siblings);
  }
  const result: (Term & { depth: number })[] = [];
  const seen = new Set<number>();
  function append(roots: Term[]) {
    const stack = roots
      .slice()
      .reverse()
      .map((term) => ({ ...term, depth: 0 }));
    while (stack.length) {
      const term = stack.pop()!;
      if (seen.has(term.id)) continue;
      seen.add(term.id);
      result.push(term);
      for (const child of (children.get(term.id) || []).slice().reverse())
        stack.push({ ...child, depth: term.depth + 1 });
    }
  }
  append(children.get(null) || []);
  for (const term of terms) if (!seen.has(term.id)) append([term]);
  return result;
}
