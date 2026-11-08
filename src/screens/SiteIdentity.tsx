import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, date, json, type Media } from "../api";
import {
  errorText,
  Modal,
  Notice,
  ResourceState,
  useResource,
} from "../components/AdminUI";
import { AccountLayout } from "./Accounts";
import "../site-identity.css";

export type PendingAdminEmail = {
  email: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};
export function PendingEmailNotice({
  pending,
  currentEmail,
  onChanged,
}: {
  pending: PendingAdminEmail | null | undefined;
  currentEmail: string;
  onChanged: (pending: PendingAdminEmail | null) => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  if (!pending) return null;
  async function run(action: "resend" | "cancel") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "cancel") {
        await api("/settings/admin-email", json("DELETE"));
        onChanged(null);
      } else {
        const result = await api<{ pending: PendingAdminEmail }>(
          "/settings/admin-email/resend",
          json("POST"),
        );
        onChanged(result.pending);
        setNotice("Confirmation email resent.");
      }
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pending-admin-email">
      <p>
        {pending.expired
          ? "The confirmation link for"
          : "A confirmation is pending for"}{" "}
        <strong>{pending.email}</strong>
        {pending.expired ? " has expired." : "."} The current administration
        address remains <strong>{currentEmail}</strong> until the new address is
        confirmed.
      </p>
      <p>
        {pending.expired
          ? "Resend to request a new confirmation link."
          : `Confirm before ${new Date(pending.expiresAt).toLocaleString()}.`}
      </p>
      <div className="identity-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void run("resend")}
        >
          Resend confirmation
        </button>
        <button
          type="button"
          className="button-link"
          disabled={busy}
          onClick={() => void run("cancel")}
        >
          Cancel email change
        </button>
        <Link to="/admin/tools?tab=mail">View outgoing mail</Link>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
export function AdminEmailConfirmation() {
  const [params] = useSearchParams(),
    token = params.get("token") || "";
  const resource = useResource<{
    email: string;
    expiresAt: string;
    siteTitle: string;
  }>(`/settings/admin-email/confirmation?token=${encodeURIComponent(token)}`);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [complete, setComplete] = useState(false);
  async function confirm(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/settings/admin-email/confirmation", json("POST", { token }));
      setComplete(true);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AccountLayout>
      <ResourceState
        loading={resource.loading}
        error={resource.error}
        retry={resource.reload}
      />
      {error && (
        <div id="login_error" role="alert">
          {error}
        </div>
      )}
      {complete ? (
        <>
          <p className="message">
            The administration email address has been updated.
          </p>
          <p>
            <Link to="/admin/settings">Return to General settings</Link>
          </p>
        </>
      ) : (
        resource.data && (
          <>
            <p className="message">
              Confirm the administration email address for{" "}
              {resource.data.siteTitle}.
            </p>
            <form onSubmit={confirm}>
              <p>
                Change the administration email address to{" "}
                <strong>{resource.data.email}</strong>?
              </p>
              <p>
                This link expires{" "}
                {new Date(resource.data.expiresAt).toLocaleString()}. Opening
                this page does not change the address.
              </p>
              <p className="submit">
                <button
                  className="button button-primary button-large"
                  disabled={busy}
                >
                  {busy ? "Confirming…" : "Confirm Email Address"}
                </button>
              </p>
            </form>
          </>
        )
      )}
    </AccountLayout>
  );
}

type DateFormatter = (
  format: string,
  value: string,
  timezone: string,
) => string;
export function DateFormatControl({
  kind,
  value,
  timezone,
  onChange,
}: {
  kind: "date" | "time";
  value: string;
  timezone: string;
  onChange: (value: string) => void;
}) {
  const choices =
    kind === "date"
      ? ["F j, Y", "Y-m-d", "m/d/Y", "d/m/Y"]
      : ["g:i a", "g:i A", "H:i"];
  const [custom, setCustom] = useState(!choices.includes(value)),
    [formatter, setFormatter] = useState<DateFormatter | null>(null);
  const sample = useRef(new Date().toISOString());
  useEffect(() => {
    let active = true;
    import("@wordpress/date").then((module) => {
      if (active)
        setFormatter(
          () => (format: string, dateValue: string, zone: string) =>
            module.date(format, dateValue, zone),
        );
    });
    return () => {
      active = false;
    };
  }, []);
  function preview(format: string) {
    if (!formatter) return "Loading preview…";
    try {
      return formatter(format, sample.current, timezone);
    } catch {
      return "Enter a valid format.";
    }
  }
  return (
    <fieldset className="site-date-format">
      <legend className="screen-reader-text">
        {kind === "date" ? "Date" : "Time"} Format
      </legend>
      {choices.map((format) => (
        <label key={format}>
          <input
            type="radio"
            name={`${kind}-format-choice`}
            checked={!custom && value === format}
            onChange={() => {
              setCustom(false);
              onChange(format);
            }}
          />
          <span>{preview(format)}</span>
          <code>{format}</code>
        </label>
      ))}
      <label>
        <input
          type="radio"
          name={`${kind}-format-choice`}
          checked={custom}
          onChange={() => setCustom(true)}
        />
        Custom:
      </label>
      <input
        type="text"
        aria-label={`Custom ${kind} format`}
        maxLength={80}
        className="regular-text"
        disabled={!custom}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={custom}
      />
      <p className="description" aria-live="polite">
        Preview: <strong>{preview(value)}</strong>
      </p>
    </fieldset>
  );
}
export function SiteIconControl({
  id,
  url,
  onChange,
}: {
  id: number;
  url: string | null;
  onChange: (id: number, url: string | null) => void;
}) {
  const [open, setOpen] = useState(false),
    [crop, setCrop] = useState<Media | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [search, setSearch] = useState("");
  const resource = useResource<{ media: Media[] }>(
      open ? "/media?type=image&perPage=1000" : null,
    ),
    file = useRef<HTMLInputElement>(null);
  const currentIcon = useResource<{ media: Media }>(
    id > 0 ? `/media/${id}` : null,
  );
  const iconURL = url || (id > 0 ? currentIcon.data?.media.url : null);
  async function upload(files: FileList | null) {
    const selected = files?.[0];
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const data = new FormData();
      data.append("file", selected);
      const result = await api<{ media: Media }>("/media", {
        method: "POST",
        body: data,
      });
      await resource.reload();
      if ((result.media.width || 0) < 512 || (result.media.height || 0) < 512)
        throw Error(
          "Choose an image at least 512 by 512 pixels. The uploaded original remains in the Media Library.",
        );
      setCrop(result.media);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api("/settings", json("PUT", { siteIconId: 0 }));
      onChange(0, null);
      window.dispatchEvent(new Event("worldact-settings-updated"));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="site-icon-control">
      {iconURL && (
        <div className="site-icon-previews">
          <div>
            <img
              className="site-icon-browser"
              src={iconURL}
              alt="Current site icon"
            />
            <span>Browser icon</span>
          </div>
          <div>
            <img
              className="site-icon-app"
              src={iconURL}
              alt="Site icon preview on a device"
            />
            <span>App icon</span>
          </div>
        </div>
      )}
      <div className="identity-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            setOpen(true);
            setError("");
          }}
        >
          {id ? "Change Site Icon" : "Choose a Site Icon"}
        </button>
        {id > 0 && (
          <button
            type="button"
            className="button-link button-link-delete"
            disabled={busy}
            onClick={() => void remove()}
          >
            Remove Site Icon
          </button>
        )}
      </div>
      <p className="description">
        Site Icons appear in browser tabs, bookmarks, and mobile apps. Choose an
        image at least 512 by 512 pixels.
      </p>
      {error && !open && <Notice error>{error}</Notice>}
      {open && !crop && (
        <Modal
          title="Choose a Site Icon"
          close={() => {
            if (!busy) setOpen(false);
          }}
        >
          <input
            type="file"
            ref={file}
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            aria-label="Upload a site icon image"
            hidden
            onChange={(event) => void upload(event.target.files)}
          />
          <div className="site-icon-picker-toolbar">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => file.current?.click()}
            >
              {busy ? "Uploading…" : "Upload Files"}
            </button>
            <input
              type="search"
              aria-label="Search images"
              placeholder="Search images"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          {error && <Notice error>{error}</Notice>}
          <ResourceState
            loading={resource.loading}
            error={resource.error}
            retry={resource.reload}
          />
          <div className="site-icon-picker-grid">
            {resource.data?.media
              .filter((item) =>
                item.title.toLowerCase().includes(search.toLowerCase()),
              )
              .map((item) => {
                const small =
                  (item.width || 0) < 512 || (item.height || 0) < 512;
                return (
                  <button
                    type="button"
                    key={item.id}
                    disabled={small || busy}
                    onClick={() => setCrop(item)}
                    title={
                      small
                        ? "This image is smaller than 512 by 512 pixels."
                        : item.title
                    }
                  >
                    <img
                      src={item.sizes?.thumbnail?.url || item.url}
                      alt={item.alt || item.title}
                    />
                    <strong>{item.title}</strong>
                    <span>
                      {item.width} × {item.height}
                      {small ? " — too small" : ""}
                    </span>
                  </button>
                );
              })}
          </div>
          {!resource.loading && !resource.data?.media.length && (
            <p>No images available. Upload an image to choose a site icon.</p>
          )}
        </Modal>
      )}
      {open && crop && (
        <CropSiteIcon
          media={crop}
          close={() => {
            setCrop(null);
            setError("");
          }}
          saved={(iconId, iconURL) => {
            onChange(iconId, iconURL);
            setOpen(false);
            setCrop(null);
            window.dispatchEvent(new Event("worldact-settings-updated"));
          }}
        />
      )}
    </div>
  );
}
function CropSiteIcon({
  media,
  close,
  saved,
}: {
  media: Media;
  close: () => void;
  saved: (id: number, url: string) => void;
}) {
  const [dimensions, setDimensions] = useState({
    width: media.width || 512,
    height: media.height || 512,
  });
  const width = dimensions.width,
    height = dimensions.height,
    max = Math.min(width, height);
  const [size, setSize] = useState(max),
    [left, setLeft] = useState(Math.floor((width - max) / 2)),
    [top, setTop] = useState(Math.floor((height - max) / 2));
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [imageReady, setImageReady] = useState(false);
  const frame = useRef<HTMLDivElement>(null),
    drag = useRef<{ x: number; y: number; left: number; top: number } | null>(
      null,
    );
  function resize(value: number) {
    const next = Math.max(512, Math.min(max, Math.round(value) || 512));
    setSize(next);
    setLeft((current) => Math.min(current, width - next));
    setTop((current) => Math.min(current, height - next));
  }
  function start(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, left, top };
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current || !frame.current) return;
    const scale = width / frame.current.clientWidth;
    setLeft(
      Math.max(
        0,
        Math.min(
          width - size,
          Math.round(
            drag.current.left + (event.clientX - drag.current.x) * scale,
          ),
        ),
      ),
    );
    setTop(
      Math.max(
        0,
        Math.min(
          height - size,
          Math.round(
            drag.current.top + (event.clientY - drag.current.y) * scale,
          ),
        ),
      ),
    );
  }
  async function save(center = false) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ siteIconId: number; url: string }>(
        "/settings/site-icon",
        json("POST", {
          mediaId: media.id,
          ...(center ? {} : { crop: { left, top, width: size, height: size } }),
        }),
      );
      saved(result.siteIconId, result.url);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Crop Site Icon"
      close={() => {
        if (!busy) close();
      }}
    >
      <p>
        Select a square area for your site icon. Drag the selection to
        reposition it, or adjust the crop values below.
      </p>
      <div
        className="site-icon-crop-frame"
        ref={frame}
        style={{
          aspectRatio: `${width}/${height}`,
          width: `min(100%, 640px, ${(60 * width) / height}vh)`,
        }}
      >
        <img
          src={media.url}
          alt={media.alt || media.title}
          draggable={false}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            if (naturalWidth !== width || naturalHeight !== height) {
              const side = Math.min(naturalWidth, naturalHeight);
              setDimensions({ width: naturalWidth, height: naturalHeight });
              setSize(side);
              setLeft(Math.floor((naturalWidth - side) / 2));
              setTop(Math.floor((naturalHeight - side) / 2));
            }
            setImageReady(true);
          }}
          onError={() =>
            setError("The image could not be loaded. Choose another image.")
          }
        />
        <div
          className="site-icon-crop-selection"
          style={{
            left: `${(left / width) * 100}%`,
            top: `${(top / height) * 100}%`,
            width: `${(size / width) * 100}%`,
            height: `${(size / height) * 100}%`,
          }}
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        />
      </div>
      <div className="site-icon-crop-controls">
        <label>
          Left
          <input
            type="number"
            min={0}
            max={width - size}
            value={left}
            onChange={(event) =>
              setLeft(
                Math.max(
                  0,
                  Math.min(width - size, Number(event.target.value) || 0),
                ),
              )
            }
          />
        </label>
        <label>
          Top
          <input
            type="number"
            min={0}
            max={height - size}
            value={top}
            onChange={(event) =>
              setTop(
                Math.max(
                  0,
                  Math.min(height - size, Number(event.target.value) || 0),
                ),
              )
            }
          />
        </label>
        <label>
          Crop size
          <input
            type="number"
            min={512}
            max={max}
            value={size}
            onChange={(event) => resize(Number(event.target.value))}
          />
        </label>
        <label className="site-icon-size-slider">
          Selection size
          <input
            type="range"
            min={512}
            max={max}
            value={size}
            onChange={(event) => resize(Number(event.target.value))}
          />
        </label>
      </div>
      <p className="description">
        The saved icon will be 512 × 512 pixels. Your original image stays in
        the Media Library.
      </p>
      {error && <Notice error>{error}</Notice>}
      <div className="identity-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={close}
        >
          Back
        </button>
        <button
          type="button"
          className="button"
          disabled={busy || !imageReady}
          onClick={() => void save(true)}
        >
          Use Center Crop
        </button>
        <button
          type="button"
          className="button button-primary"
          disabled={busy || !imageReady}
          onClick={() => void save()}
        >
          {busy ? "Cropping…" : "Crop Image"}
        </button>
      </div>
    </Modal>
  );
}
