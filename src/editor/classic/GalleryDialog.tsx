/** React data adapter for the source wpgallery frame update contract. Uses the
 * existing real media picker; source shortcode parsing and TinyMCE placeholder
 * serialization remain upstream, including untouched shortcode attributes. */
import { useState, type ComponentType } from "react";
import { Button, Modal, Notice } from "@wordpress/components";
import type { Media } from "../../api";
import { api } from "../../api";
import type { ClassicGallery } from "./gallery";
import "./classic.css";
export function GalleryDialog({
  initial,
  media,
  Picker,
  onClose,
  onUpdate,
  onMediaUpdate,
}: {
  initial: ClassicGallery;
  media: Media[];
  Picker: ComponentType<any>;
  onClose: () => void;
  onUpdate: (value: ClassicGallery) => void;
  onMediaUpdate?: (item: Media) => void;
}) {
  const [gallery, setGallery] = useState(initial),
    [error, setError] = useState("");
  const update = (key: string, value: string) =>
    setGallery((current) => ({
      ...current,
      attrs: { ...current.attrs, [key]: value },
    }));
  const images = gallery.ids
    .map((id) => media.find((item) => item.id === id))
    .filter((item): item is Media => !!item);
  const move = (id: number, step: number) =>
    setGallery((current) => {
      const ids = [...current.ids],
        i = ids.indexOf(id),
        j = i + step;
      if (i >= 0 && j >= 0 && j < ids.length)
        [ids[i], ids[j]] = [ids[j], ids[i]];
      return { ...current, ids };
    });
  return (
    <Modal
      title="Edit gallery"
      onRequestClose={onClose}
      size="large"
      className="worldact-classic-gallery"
    >
      <div className="worldact-classic-gallery-toolbar">
        <Picker
          allowedTypes={["image"]}
          multiple
          title="Add to gallery"
          onSelect={(items: any[]) =>
            setGallery((current) => ({
              ...current,
              ids: [
                ...new Set([...current.ids, ...items.map((item) => item.id)]),
              ],
            }))
          }
          render={({ open }: { open: () => void }) => (
            <Button variant="secondary" onClick={open}>
              Add to gallery
            </Button>
          )}
        />
      </div>
      {gallery.ids.some((id) => !media.some((item) => item.id === id)) && (
        <Notice status="warning" isDismissible={false}>
          Some images could not be loaded. They will remain in this gallery.
        </Notice>
      )}
      {error && (
        <Notice status="error" onRemove={() => setError("")}>
          {error}
        </Notice>
      )}
      <div className="worldact-classic-gallery-layout">
        <div
          className="worldact-classic-gallery-images"
          role="group"
          aria-label="Gallery images"
        >
          {images.map((item, index) => (
            <div className="worldact-classic-gallery-image" key={item.id}>
              <img src={item.url} alt={item.alt || item.title} />
              <span>{item.title}</span>
              <label>
                Caption
                <textarea
                  defaultValue={item.caption || ""}
                  onBlur={(event) => {
                    const caption = event.currentTarget.value;
                    if (caption !== item.caption)
                      void api<{ media: Media }>(`/media/${item.id}`, {
                        method: "PUT",
                        body: JSON.stringify({ caption }),
                      })
                        .then(({ media }) => onMediaUpdate?.(media))
                        .catch((reason) =>
                          setError(
                            reason.message || "The caption could not be saved.",
                          ),
                        );
                  }}
                />
              </label>
              <div>
                <Button
                  size="small"
                  label={`Move ${item.title} left`}
                  disabled={index === 0}
                  onClick={() => move(item.id, -1)}
                >
                  ←
                </Button>
                <Button
                  size="small"
                  label={`Move ${item.title} right`}
                  disabled={index === images.length - 1}
                  onClick={() => move(item.id, 1)}
                >
                  →
                </Button>
                <Button
                  size="small"
                  isDestructive
                  onClick={() =>
                    setGallery((current) => ({
                      ...current,
                      ids: current.ids.filter((id) => id !== item.id),
                    }))
                  }
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
          {!images.length && <p>Select images to add to this gallery.</p>}
        </div>
        <aside className="gallery-settings">
          <h2>Gallery settings</h2>
          <label>
            Link To
            <select
              value={gallery.attrs.link || "post"}
              onChange={(event) => update("link", event.target.value)}
            >
              <option value="post">Attachment Page</option>
              <option value="file">Media File</option>
              <option value="none">None</option>
            </select>
          </label>
          <label>
            Columns
            <select
              value={gallery.attrs.columns || "3"}
              onChange={(event) => update("columns", event.target.value)}
            >
              {Array.from({ length: 9 }, (_, i) => (
                <option key={i + 1}>{i + 1}</option>
              ))}
            </select>
          </label>
          <label className="worldact-classic-gallery-checkbox">
            <input
              type="checkbox"
              checked={gallery.attrs.orderby === "rand"}
              onChange={(event) =>
                update(
                  "orderby",
                  event.target.checked ? "rand" : "menu_order ID",
                )
              }
            />
            Random Order
          </label>
          <label>
            Size
            <select
              value={gallery.attrs.size || "thumbnail"}
              onChange={(event) => update("size", event.target.value)}
            >
              <option value="thumbnail">Thumbnail</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
              <option value="full">Full Size</option>
            </select>
          </label>
        </aside>
      </div>
      <div className="worldact-classic-gallery-actions">
        <Button variant="tertiary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!gallery.ids.length}
          onClick={() => {
            onUpdate(gallery);
            onClose();
          }}
        >
          Update gallery
        </Button>
      </div>
    </Modal>
  );
}
