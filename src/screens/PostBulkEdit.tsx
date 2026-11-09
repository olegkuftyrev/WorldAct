import { postFormats, type PostFormat } from "../../shared/post-formats";
import PostTemplateSelect from "../components/PostTemplateSelect";
import { useState, type FormEvent } from "react";
import { api, json, type Post, type Term } from "../api";
import {
  errorText,
  Notice,
  ResourceState,
  useResource,
} from "../components/AdminUI";
import "../post-fields.css";
import { publicationDateInput, publicationInstant } from "../editor/publicationDate";

export type Author = {
  id: number;
  displayName: string;
  username: string;
  role: string;
};
export { postFormats, type PostFormat } from "../../shared/post-formats";
export type PostChanges = Omit<Partial<Post>, "postDate"> & {
  postDate?: string | null;
  pingStatus?: "open" | "closed";
  authorId?: number;
  password?: string;
};
export type BulkPostResult = {
  updated: number[];
  errors: { id: number; status: number; error: string }[];
  posts: Post[];
};
const names: Record<string, string> = {
  draft: "Draft",
  pending: "Pending Review",
  publish: "Published",
  private: "Private",
  future: "Scheduled",
};
const capitalized = (value: string) => value[0].toUpperCase() + value.slice(1);

export default function PostBulkEdit({
  posts,
  type,
  canPublish,
  canSticky,
  authors,
  authorsError,
  terms,
  close,
  saved,
  timezone,
}: {
  posts: Post[];
  type: "post" | "page";
  canPublish: boolean;
  canSticky: boolean;
  authors: Author[];
  authorsError: string;
  terms: Term[];
  close: () => void;
  saved: (result: BulkPostResult) => Promise<void>;
  timezone?: string;
}) {
  const [ids, setIds] = useState(posts.map((post) => post.id));
  const [changes, setChanges] = useState<PostChanges>({});
  const [categoryMode, setCategoryMode] = useState<"add" | "replace">("add"),
    [tagMode, setTagMode] = useState<"add" | "replace">("add");
  const [passwordMode, setPasswordMode] = useState(false),
    [postDate, setPostDate] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pages = useResource<{ posts: Post[] }>(
    type === "page" ? "/posts?type=page&status=all&perPage=100" : null,
  );
  function change<K extends keyof PostChanges>(
    key: K,
    value: PostChanges[K] | "",
  ) {
    setChanges((current) => {
      const next = { ...current };
      if (value === "") delete next[key];
      else next[key] = value as PostChanges[K];
      return next;
    });
  }
  function termsField(taxonomy: "category" | "tag") {
    const key = taxonomy === "category" ? "categoryIds" : "tagIds";
    const mode = taxonomy === "category" ? categoryMode : tagMode;
    return (
      <fieldset className="bulk-term-fields">
        <legend>{taxonomy === "category" ? "Categories" : "Tags"}</legend>
        <label>
          Update method
          <select
            value={mode}
            onChange={(event) => {
              const value = event.target.value as "add" | "replace";
              if (taxonomy === "category") setCategoryMode(value);
              else setTagMode(value);
              if (value === "replace" && !changes[key]) change(key, []);
              else if (value === "add" && !changes[key]?.length)
                change(key, "");
            }}
          >
            <option value="add">Add selected</option>
            <option value="replace">Replace existing</option>
          </select>
        </label>
        <div className="bulk-term-checklist">
          {terms
            .filter((term) => term.taxonomy === taxonomy)
            .map((term) => (
              <label className="checkbox-label" key={term.id}>
                <input
                  type="checkbox"
                  checked={changes[key]?.includes(term.id) || false}
                  onChange={(event) => {
                    const selected = event.target.checked
                      ? [...(changes[key] || []), term.id]
                      : (changes[key] || []).filter((id) => id !== term.id);
                    change(
                      key,
                      selected.length || mode === "replace" ? selected : "",
                    );
                  }}
                />
                {term.name}
              </label>
            ))}
          {!terms.some((term) => term.taxonomy === taxonomy) && (
            <p>
              No {taxonomy === "category" ? "categories" : "tags"} available.
            </p>
          )}
        </div>
        {mode === "replace" && (
          <p className="description">
            Existing {taxonomy === "category" ? "categories" : "tags"} will be
            replaced for every selected post.
          </p>
        )}
      </fieldset>
    );
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (!ids.length) {
      setError("Select at least one item to update.");
      return;
    }
    if (!Object.keys(changes).length && !passwordMode) {
      setError("Choose at least one field to change.");
      return;
    }
    if (
      changes.status === "future" &&
      (!timezone || !publicationInstant(postDate, timezone))
    ) {
      setError("Choose a valid publication date and time.");
      return;
    }
    setBusy(true);
    try {
      const result = await api<BulkPostResult>(
        "/posts/bulk",
        json("POST", {
          ids,
          changes: {
            ...changes,
            ...(changes.status === "future"
              ? { postDate }
              : {}),
            ...(!passwordMode ? {} : { password: changes.password || "" }),
          },
          categoryMode,
          tagMode,
          versions: Object.fromEntries(
            posts
              .filter((post) => ids.includes(post.id))
              .map((post) => [post.id, post.version]),
          ),
        }),
      );
      await saved(result);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="quick-edit-form worldact-bulk-edit" onSubmit={submit}>
      <h3>Bulk Edit</h3>
      {error && <Notice error>{error}</Notice>}
      {authorsError && <Notice error>{authorsError}</Notice>}
      <div className="bulk-post-selection" aria-label="Selected content">
        {posts
          .filter((post) => ids.includes(post.id))
          .map((post) => (
            <div key={post.id}>
              <button
                type="button"
                className="button-link"
                disabled={busy}
                aria-label={`Remove ${post.title || "untitled item"} from bulk edit`}
                onClick={() =>
                  setIds((current) => current.filter((id) => id !== post.id))
                }
              >
                ×
              </button>
              <span>{post.title || "(no title)"}</span>
            </div>
          ))}
      </div>
      <p className="description">
        Only fields changed below will be applied to the selected{" "}
        {type === "post" ? "posts" : "pages"}.
      </p>
      <div className="quick-edit-fields">
        <fieldset>
          <label>
            Author
            <select
              value={changes.authorId ?? ""}
              disabled={!authors.length}
              onChange={(event) =>
                change(
                  "authorId",
                  event.target.value ? Number(event.target.value) : "",
                )
              }
            >
              <option value="">— No change —</option>
              {authors.map((author) => (
                <option value={author.id} key={author.id}>
                  {author.displayName} ({author.username})
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select
              value={changes.status ?? ""}
              onChange={(event) =>
                change("status", event.target.value as Post["status"] | "")
              }
            >
              <option value="">— No change —</option>
              {[
                "draft",
                "pending",
                ...(canPublish ? ["publish", "private", "future"] : []),
              ].map((status) => (
                <option value={status} key={status}>
                  {names[status]}
                </option>
              ))}
            </select>
          </label>
          {changes.status === "future" && (
            <label>
              Publish on
              <input
                type="datetime-local"
                aria-label="Bulk publication date"
                aria-describedby="bulk-publication-date-zone"
                step="1"
                min="0001-01-01T00:00:00"
                max="9999-12-31T23:59:59"
                required
                disabled={!timezone}
                value={postDate}
                onChange={(event) => setPostDate(publicationDateInput(event.target.value))}
              />
              <span className="description" id="bulk-publication-date-zone">{timezone ? `Site timezone: ${timezone}` : "Loading site timezone…"}</span>
            </label>
          )}
          <label>
            Comments
            <select
              value={changes.commentStatus ?? ""}
              onChange={(event) =>
                change(
                  "commentStatus",
                  event.target.value as "open" | "closed" | "",
                )
              }
            >
              <option value="">— No change —</option>
              <option value="open">Allow</option>
              <option value="closed">Do not allow</option>
            </select>
          </label>
          <label>
            Pings
            <select
              value={changes.pingStatus ?? ""}
              onChange={(event) =>
                change(
                  "pingStatus",
                  event.target.value as "open" | "closed" | "",
                )
              }
            >
              <option value="">— No change —</option>
              <option value="open">Allow</option>
              <option value="closed">Do not allow</option>
            </select>
          </label>
        </fieldset>
        {type === "post" ? (
          <>
            {termsField("category")}
            {termsField("tag")}
            <fieldset>
              <label>
                Format
                <select
                  value={changes.format ?? ""}
                  onChange={(event) =>
                    change("format", event.target.value as PostFormat | "")
                  }
                >
                  <option value="">— No change —</option>
                  {postFormats.map((format) => (
                    <option value={format} key={format}>
                      {capitalized(format)}
                    </option>
                  ))}
                </select>
              </label>
              {canSticky && (
                <label>
                  Sticky
                  <select
                    value={
                      changes.sticky === undefined ? "" : String(changes.sticky)
                    }
                    onChange={(event) =>
                      change(
                        "sticky",
                        event.target.value === ""
                          ? ""
                          : event.target.value === "true",
                      )
                    }
                  >
                    <option value="">— No change —</option>
                    <option value="true">Sticky</option>
                    <option value="false">Not sticky</option>
                  </select>
                </label>
              )}
            </fieldset>
          </>
        ) : (
          <fieldset>
            <ResourceState
              loading={pages.loading}
              error={pages.error}
              retry={pages.reload}
            />
            <label>
              Parent
              <select
                value={
                  changes.parentId === undefined
                    ? ""
                    : (changes.parentId ?? "0")
                }
                onChange={(event) =>
                  change(
                    "parentId",
                    event.target.value === ""
                      ? ""
                      : Number(event.target.value) || null,
                  )
                }
              >
                <option value="">— No change —</option>
                <option value="0">(no parent)</option>
                {pages.data?.posts
                  .filter((page) => !ids.includes(page.id))
                  .map((page) => (
                    <option value={page.id} key={page.id}>
                      {page.title || "(no title)"}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Order
              <input
                type="number"
                value={changes.menuOrder ?? ""}
                onChange={(event) =>
                  change(
                    "menuOrder",
                    event.target.value === "" ? "" : Number(event.target.value),
                  )
                }
              />
              <span className="description">
                Leave blank to keep each page's order.
              </span>
            </label>
          </fieldset>
        )}
        <fieldset>
          <PostTemplateSelect
            type={type}
            value={changes.templateSlug}
            allowNoChange
            onChange={(templateSlug) =>
              setChanges((current) => {
                const next = { ...current };
                if (templateSlug === undefined) delete next.templateSlug;
                else next.templateSlug = templateSlug;
                return next;
              })
            }
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={passwordMode}
              onChange={(event) => {
                setPasswordMode(event.target.checked);
                if (!event.target.checked) change("password", "");
              }}
            />
            Change password protection
          </label>
          {passwordMode && (
            <label>
              Password
              <input
                type="text"
                autoComplete="off"
                value={changes.password || ""}
                maxLength={255}
                onChange={(event) =>
                  setChanges((current) => ({
                    ...current,
                    password: event.target.value,
                  }))
                }
              />
              <span className="description">
                Leave blank to remove password protection.
              </span>
            </label>
          )}
        </fieldset>
      </div>
      <div className="quick-edit-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={close}
        >
          Cancel
        </button>
        <button
          className="button button-primary"
          disabled={busy || !ids.length}
        >
          {busy ? "Updating…" : "Update"}
        </button>
      </div>
    </form>
  );
}
