import {
  useContext,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import { Link } from "react-router-dom";
import { api, json, type Term } from "../api";
import {
  Session,
  Notice,
  ResourceState,
  useResource,
  errorText,
} from "../components/AdminUI";

export default function Taxonomies({
  taxonomy,
}: {
  taxonomy: "category" | "tag";
}) {
  const { user } = useContext(Session);
  const resource = useResource<{ terms: Term[] }>(
    `/terms?taxonomy=${taxonomy}`,
  );
  const [editing, setEditing] = useState<Term | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<number[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const label = taxonomy === "category" ? "Categories" : "Tags";
  const singular = taxonomy === "category" ? "Category" : "Tag";
  const canManage = user?.role === "administrator" || user?.role === "editor";
  const terms = resource.data?.terms || [];
  const filtered = useMemo(
    () =>
      terms
        .filter((term) =>
          `${term.name} ${term.slug} ${term.description}`
            .toLowerCase()
            .includes(search.toLowerCase()),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [terms, search],
  );
  function reset() {
    setEditing(null);
    setName("");
    setSlug("");
    setDescription("");
    setParentId("");
  }
  useEffect(() => {
    reset();
    setQuery("");
    setSearch("");
    setSelected([]);
    setError("");
    setNotice("");
  }, [taxonomy]);
  function edit(term: Term) {
    setEditing(term);
    setName(term.name);
    setSlug(term.slug);
    setDescription(term.description);
    setParentId(term.parentId ? String(term.parentId) : "");
    setError("");
    document.getElementById("term-name")?.focus();
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
      await resource.reload();
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
      await resource.reload();
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
            filtered.length > 0 &&
            filtered.every((term) => selected.includes(term.id))
          }
          onChange={(e) =>
            setSelected(e.target.checked ? filtered.map((term) => term.id) : [])
          }
        />
      </td>
      <th scope="col" className="column-primary">
        Name
      </th>
      <th scope="col">Description</th>
      <th scope="col">Slug</th>
      <th scope="col" className="column-posts">
        Count
      </th>
    </tr>
  );
  return (
    <main className="wrap taxonomy-wrap">
      <h1>{label}</h1>
      {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
      {error && <Notice error>{error}</Notice>}
      <ResourceState
        loading={resource.loading}
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
            aria-label={`${editing ? "Edit" : "Add new"} ${singular.toLowerCase()}`}
          >
            <h2>{editing ? `Edit ${singular}` : `Add New ${singular}`}</h2>
            <form onSubmit={save}>
              <div className="form-field">
                <label htmlFor="term-name">Name</label>
                <input
                  id="term-name"
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
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                />
                <p>
                  The “slug” is the URL-friendly version of the name. It is
                  usually all lowercase and contains only letters, numbers, and
                  hyphens.
                </p>
              </div>
              {taxonomy === "category" && (
                <div className="form-field">
                  <label htmlFor="term-parent">Parent Category</label>
                  <select
                    id="term-parent"
                    value={parentId}
                    onChange={(e) => setParentId(e.target.value)}
                  >
                    <option value="">None</option>
                    {terms
                      .filter(
                        (term) => !editing || !descendantOf(term, editing.id),
                      )
                      .map((term) => (
                        <option key={term.id} value={term.id}>
                          {term.name}
                        </option>
                      ))}
                  </select>
                  <p>Categories, unlike tags, can have a hierarchy.</p>
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
                <p>The description appears in your category or tag archive.</p>
              </div>
              <p className="submit">
                <button className="button button-primary" disabled={busy}>
                  {busy
                    ? "Saving…"
                    : editing
                      ? "Update"
                      : `Add New ${singular}`}
                </button>
                {editing && (
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
                setSearch(query);
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
                  disabled={busy || !selected.length}
                  onClick={() => void remove(selected)}
                >
                  Delete selected
                </button>
              </div>
              <div className="tablenav-pages">
                <span className="displaying-num">
                  {filtered.length} {filtered.length === 1 ? "item" : "items"}
                </span>
              </div>
            </div>
            <table className="wp-list-table widefat fixed striped table-view-list tags">
              <thead>{header}</thead>
              <tbody>
                {filtered.map((term) => (
                  <tr key={term.id}>
                    <th scope="row" className="check-column">
                      <input
                        type="checkbox"
                        aria-label={`Select ${term.name}`}
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
                        <button
                          className="row-title button-link"
                          onClick={() => edit(term)}
                        >
                          {term.parentId ? "— " : ""}
                          {term.name}
                        </button>
                      </strong>
                      <div className="row-actions">
                        <button
                          className="button-link"
                          onClick={() => edit(term)}
                        >
                          Edit
                        </button>
                        {term.slug !== "uncategorized" && (
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
                    </td>
                    <td>{term.description || "—"}</td>
                    <td>{term.slug}</td>
                    <td className="column-posts">
                      <Link to={`/admin/posts?${taxonomy}=${term.id}`}>
                        {term.count}
                      </Link>
                    </td>
                  </tr>
                ))}
                {!resource.loading && !filtered.length && (
                  <tr>
                    <td colSpan={5}>No {label.toLowerCase()} found.</td>
                  </tr>
                )}
              </tbody>
              <tfoot>{header}</tfoot>
            </table>
            {taxonomy === "category" && (
              <p className="description">
                Deleting a category does not delete the posts in that category.
                Posts without a category are assigned to the default category,
                Uncategorized.
              </p>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
