import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import { api, json, date, type Media, type Post } from "../api";
import {
  Session,
  Icon,
  ScreenTabs,
  Notice,
  ResourceState,
  useResource,
  Modal,
  errorText,
} from "../components/AdminUI";
import {
  ListTableOptions,
  useListTablePreferences,
} from "../components/ScreenOptions";
import MediaImageEditor from "../components/MediaImageEditor";
import { mergeMediaDetails } from "../mediaDetailsState";
import "../media.css";

type MediaItem = Media & {
  attachedPostId?: number | null;
  attachedPostTitle?: string | null;
  description?: string;
  commentStatus?: "open" | "closed";
  authorId?: number;
  authorName?: string;
};
type MediaResult = {
  media: MediaItem[];
  counts: Record<string, number>;
  months: string[];
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
};
type BulkResult = {
  updated: number;
  errors: { id: number; message: string }[];
};
const canUploadMedia = (role: string | undefined) => Boolean(role && role !== "contributor" && role !== "subscriber");
export function MediaPreview({
  item,
  full = false,
}: {
  item: Media;
  full?: boolean;
}) {
  if (item.mimeType.startsWith("image/"))
    return (
      <img
        src={full ? item.url : item.sizes?.thumbnail?.url || item.url}
        alt={item.alt || item.title}
        loading="lazy"
      />
    );
  if (full && item.mimeType.startsWith("audio/"))
    return <audio controls preload="metadata" src={item.url} />;
  if (full && item.mimeType.startsWith("video/"))
    return <video controls preload="metadata" src={item.url} />;
  return (
    <div className={`media-type-preview ${full ? "full" : ""}`}>
      <Icon
        name={
          item.mimeType.startsWith("audio/")
            ? "media-audio"
            : item.mimeType.startsWith("video/")
              ? "media-video"
              : "media-document"
        }
      />
      {full && (
        <a href={item.url} target="_blank" rel="noreferrer">
          Open {item.filename}
        </a>
      )}
    </div>
  );
}
export default function MediaLibrary() {
  const { user } = useContext(Session),
    { id } = useParams(),
    route = useLocation(),
    navigate = useNavigate();
  const scopeRef = useRef({ key: route.key, user, active: true });
  if (scopeRef.current.key !== route.key || scopeRef.current.user !== user) {
    scopeRef.current.active = false;
    scopeRef.current = { key: route.key, user, active: true };
  }
  const scope = scopeRef.current;
  const ownsOpening = () => scope.active && scopeRef.current === scope;
  useEffect(() => { scope.active = true; return () => { scope.active = false; }; }, [scope]);
  const [params, setParams] = useSearchParams();
  const preferences = useListTablePreferences("media");
  const type = ["image", "audio", "video", "document"].includes(
    params.get("type") || "",
  )
    ? params.get("type")!
    : "all";
  const search = params.get("search") || "",
    month = params.get("month") || "",
    unattached = params.get("unattached") === "true";
  const orderby = ["title", "author", "date"].includes(
      params.get("orderby") || "",
    )
      ? params.get("orderby")!
      : "date",
    order = params.get("order") === "asc" ? "asc" : "desc";
  const page = Math.max(1, Math.floor(Number(params.get("page")) || 1)),
    grid = params.get("view") !== "list";
  const query = new URLSearchParams({
    search,
    type,
    ...(month ? { month } : {}),
    page: String(page),
    perPage: String(preferences.value.perPage),
    orderby,
    order,
    ...(unattached ? { unattached: "true" } : {}),
  });
  const resource = useResource<MediaResult>(`/media?${query}`);
  const detail = useResource<{ media: MediaItem }>(
    id ? `/media/${encodeURIComponent(id)}` : null,
  );
  const uploader = canUploadMedia(user?.role) && params.get("upload") === "1";
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [searchDraft, setSearchDraft] = useState(search),
    [monthDraft, setMonthDraft] = useState(month);
  const [checked, setChecked] = useState<number[]>([]),
    [selecting, setSelecting] = useState(false),
    [bulk, setBulk] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<number[] | null>(null),
    [attaching, setAttaching] = useState<number[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const items = resource.data?.media || [],
    pagination = resource.data?.pagination;
  const currentPage = pagination?.page || page;
  const canUpload = canUploadMedia(user?.role);
  useEffect(() => {
    setSearchDraft(search);
    setMonthDraft(month);
    setChecked([]);
    setSelecting(false);
  }, [search, month, type, unattached, page]);
  useEffect(() => {
    setSelected(detail.data?.media.id === Number(id) ? detail.data.media : null);
  }, [detail.data, id]);
  useEffect(() => {
    setBusy(false); setError(""); setNotice(""); setDeleting(null); setAttaching(null);
  }, [scope]);
  function change(values: Record<string, string>) {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values))
      value ? next.set(key, value) : next.delete(key);
    if (!("page" in values)) next.delete("page");
    setParams(next);
    setChecked([]);
  }
  function open(item: MediaItem) {
    scope.active = false;
    navigate(`/admin/media/${item.id}${params.size ? `?${params}` : ""}`);
  }
  function close() {
    if (!busy) {
      scope.active = false;
      setSelected(null);
      navigate(`/admin/media${params.size ? `?${params}` : ""}`);
    }
  }
  async function upload(files: FileList | File[] | null) {
    if (!files?.length) return;
    setBusy(true);
    setError("");
    let uploaded = 0;
    try {
      for (const file of Array.from(files)) {
        const body = new FormData();
        body.append("file", file);
        await api("/media", { method: "POST", body });
        uploaded++;
        if (!ownsOpening()) return;
      }
      if (!ownsOpening()) return;
      setNotice(`${uploaded} ${uploaded === 1 ? "file" : "files"} uploaded.`);
      await resource.reload();
    } catch (reason) {
      if (!ownsOpening()) return;
      setError(
        `${uploaded ? `${uploaded} files uploaded. ` : ""}${errorText(reason)}`,
      );
      await resource.reload();
    } finally {
      if (ownsOpening()) {
        setBusy(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError("");
    const submitted = selected;
    try {
      const { media: updated } = await api<{ media: MediaItem }>(
        `/media/${selected.id}`,
        json("PUT", {
          title: selected.title,
          alt: selected.alt,
          caption: selected.caption,
          description: selected.description || "",
          commentStatus: selected.commentStatus || "open",
        }),
      );
      if (!ownsOpening()) return;
      if (updated.id !== submitted.id) return;
      setSelected(current => mergeMediaDetails(current, submitted, updated));
      setNotice("Attachment details saved.");
      await resource.reload();
    } catch (reason) {
      if (ownsOpening()) setError(errorText(reason));
    } finally {
      if (ownsOpening()) setBusy(false);
    }
  }
  async function apply(
    ids: number[],
    action: "delete" | "attach" | "detach",
    postId?: number,
  ) {
    setBusy(true);
    setError("");
    try {
      const result = await api<BulkResult>(
        "/media/bulk",
        json("POST", { ids, action, ...(postId ? { postId } : {}) }),
      );
      if (!ownsOpening()) return;
      setNotice(
        `${result.updated} ${result.updated === 1 ? "item" : "items"} ${action === "delete" ? "permanently deleted" : action === "attach" ? "attached" : "detached"}.`,
      );
      setError(
        (result.errors || [])
          .map((error) => `File #${error.id}: ${error.message}`)
          .join(" "),
      );
      setChecked([]);
      setDeleting(null);
      setAttaching(null);
      await resource.reload();
      if (!ownsOpening()) return;
      if (id && ids.includes(Number(id))) {
        if (
          action === "delete" &&
          !result.errors.some((error) => error.id === Number(id))
        ) {
          setSelected(null);
          navigate(`/admin/media${params.size ? `?${params}` : ""}`);
        } else await detail.reload();
      }
    } catch (reason) {
      if (ownsOpening()) setError(errorText(reason));
      throw reason;
    } finally {
      if (ownsOpening()) setBusy(false);
    }
  }
  function runBulk() {
    if (!checked.length) return;
    if (bulk === "delete") setDeleting([...checked]);
    else if (bulk === "attach") setAttaching([...checked]);
    else if (bulk === "detach") void apply(checked, "detach").catch(() => {});
  }
  function toggle(itemId: number) {
    setChecked((current) =>
      current.includes(itemId)
        ? current.filter((id) => id !== itemId)
        : [...current, itemId],
    );
  }
  function sort(field: string) {
    change({
      orderby: field,
      order: orderby === field && order === "asc" ? "desc" : "asc",
    });
  }
  const allChecked =
    items.length > 0 && items.every((item) => checked.includes(item.id));
  const pager = (
    <div className="tablenav-pages">
      <span className="displaying-num">
        {pagination?.total ?? items.length} items
      </span>
      {pagination && pagination.totalPages > 1 && (
        <>
          <button
            className="button"
            aria-label="Previous page"
            disabled={currentPage <= 1 || busy}
            onClick={() => change({ page: String(currentPage - 1) })}
          >
            ‹
          </button>
          <span>
            {currentPage} of {pagination.totalPages}
          </span>
          <button
            className="button"
            aria-label="Next page"
            disabled={currentPage >= pagination.totalPages || busy}
            onClick={() => change({ page: String(currentPage + 1) })}
          >
            ›
          </button>
        </>
      )}
    </div>
  );
  const header = (
    <tr>
      <td className="check-column">
        <input
          type="checkbox"
          aria-label="Select all media on this page"
          checked={allChecked}
          onChange={(event) =>
            setChecked(event.target.checked ? items.map((item) => item.id) : [])
          }
        />
      </td>
      {[
        {
          id: "title",
          label: "File",
          className: "column-title column-primary",
        },
        { id: "author", label: "Author", className: "column-author" },
        { id: "response", label: "Uploaded to", className: "column-response" },
        { id: "date", label: "Date", className: "column-date" },
      ].map((column) => (
        <th
          scope="col"
          className={column.className}
          key={column.id}
          aria-sort={
            orderby === column.id
              ? order === "asc"
                ? "ascending"
                : "descending"
              : "none"
          }
        >
          {column.id === "response" ? (
            column.label
          ) : (
            <button className="button-link" onClick={() => sort(column.id)}>
              {column.label}
              {orderby === column.id && (order === "asc" ? " ↑" : " ↓")}
            </button>
          )}
        </th>
      ))}
    </tr>
  );
  return (
    <>
      <ScreenTabs>
        <ListTableOptions
          table={preferences}
          itemLabel="media items"
          columns={[
            { id: "author", label: "Author" },
            { id: "response", label: "Uploaded to" },
            { id: "date", label: "Date" },
          ]}
          onApply={() => change({ page: "1" })}
        />
      </ScreenTabs>
      <main className="wrap worldact-media-library">
        <h1 className="wp-heading-inline">Media Library</h1>{" "}
        {canUpload && (
          <button
            className="page-title-action"
            onClick={() => change({ upload: uploader ? "" : "1" })}
          >
            Add New Media File
          </button>
        )}
        <hr className="wp-header-end" />
        {error && (
          <Notice error onDismiss={() => setError("")}>
            {error}
          </Notice>
        )}
        {notice && <Notice onDismiss={() => setNotice("")}>{notice}</Notice>}
        <input
          ref={fileInput}
          type="file"
          aria-label="Upload media files"
          multiple
          hidden
          onChange={(event) => void upload(event.target.files)}
        />
        {uploader && canUpload && (
          <div
            className="upload-ui"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              if (!busy) void upload(event.dataTransfer.files);
            }}
          >
            <h2>Drop files to upload</h2>
            <p>or</p>
            <button
              className="button button-large"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? "Uploading…" : "Select Files"}
            </button>
            <p>
              Upload images, audio, video, PDFs, and documents. The server
              checks file type and upload size.
            </p>
          </div>
        )}
        <div className="media-toolbar worldact-media-toolbar">
          <div className="view-switch">
            <button
              className={!grid ? "current" : ""}
              aria-label="List view"
              aria-pressed={!grid}
              onClick={() => change({ view: "list" })}
            >
              <Icon name="list-view" />
            </button>
            <button
              className={grid ? "current" : ""}
              aria-label="Grid view"
              aria-pressed={grid}
              onClick={() => change({ view: "grid" })}
            >
              <Icon name="grid-view" />
            </button>
          </div>
          <label className="screen-reader-text" htmlFor="media-type">
            Filter media type
          </label>
          <select
            id="media-type"
            value={unattached ? "unattached" : type}
            onChange={(event) =>
              change(
                event.target.value === "unattached"
                  ? { unattached: "true", type: "all" }
                  : { type: event.target.value, unattached: "" },
              )
            }
          >
            {[
              ["all", "All media items"],
              ["image", "Images"],
              ["audio", "Audio"],
              ["video", "Video"],
              ["document", "Documents"],
              ["unattached", "Unattached"],
            ].map(([value, label]) => (
              <option key={value} value={value}>
                {label} ({resource.data?.counts[value] || 0})
              </option>
            ))}
          </select>
          <form
            className="worldact-media-month"
            onSubmit={(event) => {
              event.preventDefault();
              change({ month: monthDraft });
            }}
          >
            <label className="screen-reader-text" htmlFor="media-month">
              Filter by date
            </label>
            <select
              id="media-month"
              value={monthDraft}
              onChange={(event) => setMonthDraft(event.target.value)}
            >
              <option value="">All dates</option>
              {[
                ...new Set([
                  ...(resource.data?.months || []),
                  ...(month ? [month] : []),
                ]),
              ].map((value) => (
                <option value={value} key={value}>
                  {new Date(`${value}-15T12:00:00`).toLocaleDateString(
                    undefined,
                    { month: "long", year: "numeric" },
                  )}
                </option>
              ))}
            </select>
            <button className="button">Filter</button>
          </form>
          <form
            className="worldact-media-search"
            onSubmit={(event) => {
              event.preventDefault();
              change({ search: searchDraft });
            }}
          >
            <input
              type="search"
              placeholder="Search media"
              aria-label="Search media"
              maxLength={200}
              value={searchDraft}
              onChange={(event) => setSearchDraft(event.target.value)}
            />
            <button className="button">Search Media</button>
          </form>
        </div>
        <ResourceState
          loading={resource.loading}
          error={resource.error}
          retry={resource.reload}
        />
        <div className="tablenav top worldact-media-actions">
          {grid && !selecting ? (
            <button
              className="button"
              onClick={() => setSelecting(true)}
              disabled={!items.length}
            >
              Bulk select
            </button>
          ) : (
            <div className="alignleft actions">
              <select
                aria-label="Bulk actions"
                value={bulk}
                onChange={(event) => setBulk(event.target.value)}
              >
                <option value="">Bulk actions</option>
                <option value="delete">Delete permanently</option>
                <option value="attach">Attach</option>
                <option value="detach">Detach</option>
              </select>
              <button
                className="button"
                disabled={!checked.length || !bulk || busy}
                onClick={runBulk}
              >
                Apply
              </button>
              {grid && (
                <>
                  <button
                    className="button"
                    onClick={() =>
                      setChecked(allChecked ? [] : items.map((item) => item.id))
                    }
                  >
                    {allChecked ? "Deselect all" : "Select all"}
                  </button>
                  <button
                    className="button"
                    onClick={() => {
                      setSelecting(false);
                      setChecked([]);
                    }}
                  >
                    Cancel selection
                  </button>
                </>
              )}
            </div>
          )}
          {pager}
        </div>
        {!resource.loading && !items.length ? (
          <div className="media-empty">
            <p>No media items found.</p>
            {canUpload && (
              <button
                className="button button-primary"
                onClick={() => {
                  change({ upload: "1" });
                  fileInput.current?.click();
                }}
              >
                Upload a file
              </button>
            )}
          </div>
        ) : grid ? (
          <div className="media-grid">
            {items.map((item) => (
              <div
                className={`worldact-media-grid-item ${checked.includes(item.id) ? "is-selected" : ""}`}
                key={item.id}
              >
                {selecting && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${item.title || item.filename}`}
                    checked={checked.includes(item.id)}
                    onChange={() => toggle(item.id)}
                  />
                )}
                <button
                  className="media-item"
                  onClick={() => (selecting ? toggle(item.id) : open(item))}
                >
                  <MediaPreview item={item} />
                  <span>{item.title || item.filename}</span>
                </button>
              </div>
            ))}
          </div>
        ) : (
          <table
            data-hidden-columns={preferences.value.hiddenColumns.join(" ")}
            className="wp-list-table widefat fixed striped media"
          >
            <thead>{header}</thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <th scope="row" className="check-column">
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.title || item.filename}`}
                      checked={checked.includes(item.id)}
                      onChange={() => toggle(item.id)}
                    />
                  </th>
                  <td className="column-title column-primary">
                    <div className="media-file-button">
                      <MediaPreview item={item} />
                      <div>
                        <strong>
                          <Link
                            to={`/admin/media/${item.id}${params.size ? `?${params}` : ""}`}
                          >
                            {item.title || item.filename}
                          </Link>
                        </strong>
                        <small>{item.filename}</small>
                        <div className="row-actions">
                          <button
                            className="button-link"
                            onClick={() => open(item)}
                          >
                            Edit
                          </button>
                          {" | "}
                          <button
                            className="button-link button-link-delete"
                            onClick={() => setDeleting([item.id])}
                          >
                            Delete permanently
                          </button>
                          {" | "}
                          <a href={item.url} target="_blank" rel="noreferrer">
                            View
                          </a>
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="column-author" data-colname="Author">
                    {item.authorName || "—"}
                  </td>
                  <td className="column-response" data-colname="Uploaded to">
                    {item.attachedPostId ? (
                      <>
                        <Link to={`/admin/posts/${item.attachedPostId}`}>
                          {item.attachedPostTitle || `#${item.attachedPostId}`}
                        </Link>
                        <br />
                        <button
                          className="button-link"
                          disabled={busy}
                          onClick={() =>
                            void apply([item.id], "detach").catch(() => {})
                          }
                        >
                          Detach
                        </button>
                      </>
                    ) : (
                      <>
                        Unattached
                        <br />
                        <button
                          className="button-link"
                          onClick={() => setAttaching([item.id])}
                        >
                          Attach
                        </button>
                      </>
                    )}
                  </td>
                  <td className="column-date" data-colname="Date">
                    {date(item.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>{header}</tfoot>
          </table>
        )}
        <div className="tablenav bottom">{pager}</div>
        {id && !attaching && !deleting && (detail.loading || detail.error) && (
          <Modal title="Attachment details" close={close}>
            <ResourceState
              loading={detail.loading}
              error={detail.error}
              retry={detail.reload}
            />
          </Modal>
        )}
        {selected &&
          id &&
          !attaching &&
          !deleting &&
          !detail.loading &&
          !detail.error && (
            <Modal key={route.key} title="Attachment details" close={close}>
              <form onSubmit={save} className="attachment-details-layout">
                <div className="attachment-preview">
                  <MediaPreview item={selected} full />
                  <MediaImageEditor
                    key={route.key}
                    media={selected}
                    onUpdate={(item) => {
                      if (!ownsOpening() || item.id !== Number(id)) return;
                      setSelected(current => mergeMediaDetails(current, null, item));
                      void resource.reload();
                    }}
                  />
                </div>
                <div className="attachment-fields">
                  <p>
                    <strong>{selected.filename}</strong>
                    <br />
                    {date(selected.createdAt)}
                    <br />
                    {selected.mimeType} · {Math.ceil(selected.size / 1024)} KB
                    {selected.width && selected.height && (
                      <>
                        <br />
                        {selected.width} × {selected.height} pixels
                      </>
                    )}
                    <br />
                    Uploaded by {selected.authorName || "—"}
                  </p>
                  <hr />
                  {selected.mimeType.startsWith("image/") && (
                    <>
                      <label>
                        Alternative Text
                        <textarea
                          rows={2}
                          value={selected.alt}
                          onChange={(event) =>
                            setSelected({
                              ...selected,
                              alt: event.target.value,
                            })
                          }
                        />
                      </label>
                      <p className="description">
                        Describe the purpose of the image for people who cannot
                        see it.
                      </p>
                    </>
                  )}
                  <label>
                    Title
                    <input
                      type="text"
                      required
                      maxLength={300}
                      value={selected.title}
                      onChange={(event) =>
                        setSelected({ ...selected, title: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Caption
                    <textarea
                      rows={3}
                      value={selected.caption}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          caption: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Description
                    <textarea
                      rows={5}
                      value={selected.description || ""}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          description: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={selected.commentStatus !== "closed"}
                      onChange={(event) =>
                        setSelected({
                          ...selected,
                          commentStatus: event.target.checked
                            ? "open"
                            : "closed",
                        })
                      }
                    />
                    Allow comments
                  </label>
                  <p>
                    Uploaded to: {selected.attachedPostTitle || "Unattached"}{" "}
                    <button
                      type="button"
                      className="button-link"
                      onClick={() => setAttaching([selected.id])}
                    >
                      {selected.attachedPostId ? "Change" : "Attach"}
                    </button>
                    {selected.attachedPostId && (
                      <>
                        {" "}
                        ·{" "}
                        <button
                          type="button"
                          className="button-link"
                          disabled={busy}
                          onClick={() =>
                            void apply([selected.id], "detach").catch(() => {})
                          }
                        >
                          Detach
                        </button>
                      </>
                    )}
                  </p>
                  <label>
                    File URL
                    <input
                      type="text"
                      readOnly
                      value={selected.url}
                      onFocus={(event) => event.target.select()}
                    />
                  </label>
                  {selected.originalUploadUrl && (
                    <p className="description">
                      <a href={selected.originalUploadUrl} download>
                        Download original
                      </a>
                    </p>
                  )}
                  <button
                    type="button"
                    className="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(
                          new URL(selected.url, location.origin).href,
                        );
                        if (ownsOpening()) setNotice("File URL copied.");
                      } catch {
                        if (ownsOpening()) setError(
                          "Select the file URL and copy it with your keyboard.",
                        );
                      }
                    }}
                  >
                    Copy URL to clipboard
                  </button>
                  <p className="attachment-actions">
                    <button className="button button-primary" disabled={busy}>
                      {busy ? "Saving…" : "Save changes"}
                    </button>
                    <button
                      className="button-link button-link-delete"
                      type="button"
                      disabled={busy}
                      onClick={() => setDeleting([selected.id])}
                    >
                      Delete permanently
                    </button>
                  </p>
                  {error && <Notice error>{error}</Notice>}
                  {notice && <Notice>{notice}</Notice>}
                </div>
              </form>
            </Modal>
          )}
        {deleting && (
          <Modal
            title="Delete media permanently"
            close={() => {
              if (!busy) setDeleting(null);
            }}
          >
            <p>
              You are about to permanently delete {deleting.length}{" "}
              {deleting.length === 1 ? "file" : "files"} and its generated image
              sizes. References in your content may stop displaying the deleted
              files.
            </p>
            <ul>
              {deleting.map((itemId) => (
                <li key={itemId}>
                  {items.find((item) => item.id === itemId)?.filename ||
                    (selected?.id === itemId && selected.filename) ||
                    `File #${itemId}`}
                </li>
              ))}
            </ul>
            {error && <Notice error>{error}</Notice>}
            <div className="application-password-actions">
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
                onClick={() => void apply(deleting, "delete").catch(() => {})}
              >
                {busy ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </Modal>
        )}
        {attaching && (
          <AttachMedia
            ids={attaching}
            close={() => setAttaching(null)}
            save={(postId) => apply(attaching, "attach", postId)}
          />
        )}
      </main>
    </>
  );
}
function AttachMedia({
  ids,
  close,
  save,
}: {
  ids: number[];
  close: () => void;
  save: (postId: number) => Promise<void>;
}) {
  const { user } = useContext(Session);
  const [search, setSearch] = useState(""),
    [draft, setDraft] = useState(""),
    [postId, setPostId] = useState<number | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const posts = useResource<{ posts: Post[] }>(
      `/posts?status=all&perPage=100&orderby=title&order=asc&search=${encodeURIComponent(search)}`,
    ),
    pages = useResource<{ posts: Post[] }>(
      user?.role === "administrator" || user?.role === "editor"
        ? `/posts?type=page&status=all&perPage=100&orderby=title&order=asc&search=${encodeURIComponent(search)}`
        : null,
    );
  const choices = [...(posts.data?.posts || []), ...(pages.data?.posts || [])];
  return (
    <Modal
      title="Attach to existing content"
      close={() => {
        if (!busy) close();
      }}
    >
      <form
        className="worldact-media-attach-search"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft);
          setPostId(null);
        }}
      >
        <input
          type="search"
          aria-label="Search posts and pages"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button className="button">Search</button>
      </form>
      <p>
        Choose the post or page to attach{" "}
        {ids.length === 1 ? "this file" : `these ${ids.length} files`} to.
      </p>
      <ResourceState
        loading={posts.loading || pages.loading}
        error={posts.error || pages.error}
        retry={() => {
          void posts.reload();
          void pages.reload();
        }}
      />
      <div className="worldact-media-attach-choices">
        {choices.map((post) => (
          <label key={post.id}>
            <input
              type="radio"
              name="attachment-post"
              value={post.id}
              checked={postId === post.id}
              onChange={() => setPostId(post.id)}
            />
            <span>
              {post.title || "(no title)"}
              <small>
                {post.type === "page" ? "Page" : "Post"} · {post.status}
              </small>
            </span>
          </label>
        ))}
        {!posts.loading && !pages.loading && !choices.length && (
          <p>No matching posts or pages found.</p>
        )}
      </div>
      <p className="description">
        Search to find content outside the first 100 posts and pages.
      </p>
      {error && <Notice error>{error}</Notice>}
      <div className="application-password-actions">
        <button className="button" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="button button-primary"
          disabled={busy || !postId}
          onClick={async () => {
            if (!postId) return;
            setBusy(true);
            setError("");
            try {
              await save(postId);
            } catch (reason) {
              setError(errorText(reason));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Attaching…" : "Attach"}
        </button>
      </div>
    </Modal>
  );
}
