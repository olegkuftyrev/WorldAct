import { useEffect, useState } from "react";
import { api, json, type Media } from "../api";
import { Icon, Notice, errorText } from "./AdminUI";

type ImageMedia = Media & {
  width?: number | null;
  height?: number | null;
  canRestore?: boolean;
};
type ImageEdit = {
  rotate?: number;
  flip?: boolean;
  flop?: boolean;
  width?: number;
  height?: number;
  crop?: { left: number; top: number; width: number; height: number };
};
export default function MediaImageEditor({
  media,
  onUpdate,
}: {
  media: ImageMedia;
  onUpdate: (media: Media) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [width, setWidth] = useState(media.width || 0),
    [height, setHeight] = useState(media.height || 0),
    [left, setLeft] = useState(0),
    [top, setTop] = useState(0),
    [cropWidth, setCropWidth] = useState(media.width || 0),
    [cropHeight, setCropHeight] = useState(media.height || 0),
    [lockRatio, setLockRatio] = useState(true);
  useEffect(() => {
    setWidth(media.width || 0);
    setHeight(media.height || 0);
    setLeft(0);
    setTop(0);
    setCropWidth(media.width || 0);
    setCropHeight(media.height || 0);
  }, [media.id, media.width, media.height]);
  if (!media.mimeType.startsWith("image/")) return null;
  async function edit(patch: ImageEdit | "restore") {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { media: updated } = await api<{ media: Media }>(
        `/media/${media.id}/${patch === "restore" ? "restore" : "edit"}`,
        json("POST", patch === "restore" ? {} : patch),
      );
      onUpdate(updated);
      setNotice(
        patch === "restore" ? "Original image restored." : "Image saved.",
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  function updateWidth(value: number) {
    setWidth(value);
    if (lockRatio && media.width && media.height)
      setHeight(Math.max(1, Math.round((value * media.height) / media.width)));
  }
  function updateHeight(value: number) {
    setHeight(value);
    if (lockRatio && media.width && media.height)
      setWidth(Math.max(1, Math.round((value * media.width) / media.height)));
  }
  const cropValid =
    left >= 0 &&
    top >= 0 &&
    cropWidth > 0 &&
    cropHeight > 0 &&
    (!media.width || left + cropWidth <= media.width) &&
    (!media.height || top + cropHeight <= media.height);
  return (
    <section className="media-image-editor">
      <button
        type="button"
        className="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? "Close image editor" : "Edit Image"}
      </button>
      {open && (
        <>
          <h2>Edit Image</h2>
          <p className="description">
            Changes apply to this attachment. The original image remains
            available to restore.
          </p>
          {media.width && media.height && (
            <p>
              Current dimensions: {media.width} × {media.height} pixels
            </p>
          )}
          {error && <Notice error>{error}</Notice>}
          {notice && <Notice>{notice}</Notice>}
          <div className="image-edit-toolbar">
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void edit({ rotate: -90 })}
            >
              <Icon name="image-rotate-left" /> Rotate left
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void edit({ rotate: 90 })}
            >
              <Icon name="image-rotate-right" /> Rotate right
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void edit({ flip: true })}
            >
              <Icon name="image-flip-vertical" /> Flip vertical
            </button>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void edit({ flop: true })}
            >
              <Icon name="image-flip-horizontal" /> Flip horizontal
            </button>
          </div>
          <div className="image-edit-sections">
            <fieldset disabled={busy}>
              <legend>Scale Image</legend>
              <p className="description">
                Enter the new dimensions. Images can only be made smaller.
              </p>
              <div className="image-dimensions">
                <label>
                  Width
                  <input
                    type="number"
                    min={1}
                    max={media.width || 8192}
                    value={width || ""}
                    onChange={(e) => updateWidth(Number(e.target.value))}
                  />
                </label>
                <span>×</span>
                <label>
                  Height
                  <input
                    type="number"
                    min={1}
                    max={media.height || 8192}
                    value={height || ""}
                    onChange={(e) => updateHeight(Number(e.target.value))}
                  />
                </label>
              </div>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={lockRatio}
                  onChange={(e) => setLockRatio(e.target.checked)}
                />{" "}
                Keep aspect ratio
              </label>
              <button
                type="button"
                className="button"
                disabled={
                  width < 1 ||
                  height < 1 ||
                  Boolean(media.width && width > media.width) ||
                  Boolean(media.height && height > media.height)
                }
                onClick={() => void edit({ width, height })}
              >
                Scale
              </button>
            </fieldset>
            <fieldset disabled={busy}>
              <legend>Image Crop</legend>
              <p className="description">
                Select a rectangle using pixel coordinates from the top left of
                the image.
              </p>
              <div className="image-crop-fields">
                <label>
                  Left
                  <input
                    type="number"
                    min={0}
                    max={media.width || 8192}
                    value={left}
                    onChange={(e) => setLeft(Number(e.target.value))}
                  />
                </label>
                <label>
                  Top
                  <input
                    type="number"
                    min={0}
                    max={media.height || 8192}
                    value={top}
                    onChange={(e) => setTop(Number(e.target.value))}
                  />
                </label>
                <label>
                  Width
                  <input
                    type="number"
                    min={1}
                    max={media.width || 8192}
                    value={cropWidth || ""}
                    onChange={(e) => setCropWidth(Number(e.target.value))}
                  />
                </label>
                <label>
                  Height
                  <input
                    type="number"
                    min={1}
                    max={media.height || 8192}
                    value={cropHeight || ""}
                    onChange={(e) => setCropHeight(Number(e.target.value))}
                  />
                </label>
              </div>
              <button
                type="button"
                className="button"
                disabled={!cropValid}
                onClick={() =>
                  void edit({
                    crop: { left, top, width: cropWidth, height: cropHeight },
                  })
                }
              >
                Crop
              </button>
            </fieldset>
          </div>
          {media.canRestore && (
            <p>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void edit("restore")}
              >
                Restore Original Image
              </button>
            </p>
          )}
          {busy && (
            <p role="status">
              <span className="spinner is-active" /> Saving image…
            </p>
          )}
        </>
      )}
    </section>
  );
}
