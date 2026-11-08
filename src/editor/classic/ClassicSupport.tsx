import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { Button, Notice, Spinner } from "@wordpress/components";
import { useBlockProps } from "@wordpress/block-editor";
import {
  ensureClassicRuntime,
  insertClassicMedia,
  prepareClassicMedia,
  registerClassicOwner,
} from "./runtime";
import type { Media } from "../../api";
import { GalleryDialog } from "./GalleryDialog";
import type { ClassicMediaRequest } from "./lifecycle";
type OpenMedia = (request?: ClassicMediaRequest) => void;
const MediaBridge = createContext<{
  id: string;
  MediaUpload: ComponentType<any>;
  media: Media[];
  onMediaUpdate?: (item: Media) => void;
  open: MutableRefObject<OpenMedia>;
} | null>(null);
function ClassicStatus({ children }: { children: ReactNode }) {
  return <div {...useBlockProps()}>{children}</div>;
}
/** This slot is a child of the actual Classic modal, so a media modal is nested. */
export function ClassicMediaSlot() {
  const context = useContext(MediaBridge),
    [request, setRequest] = useState<ClassicMediaRequest>({}),
    requestRef = useRef<ClassicMediaRequest>({}),
    open = useRef<() => void>(() => {}),
    [galleryOpen, setGalleryOpen] = useState(false);
  useEffect(() => {
    if (!context) return;
    const show: OpenMedia = (options) => {
      requestRef.current = options || {};
      setRequest(options || {});
      prepareClassicMedia(context.id);
      if (options?.gallery) setGalleryOpen(true);
      else open.current();
    };
    context.open.current = show;
    return () => {
      if (context.open.current === show) context.open.current = () => {};
    };
  }, [context]);
  if (!context) return null;
  const Picker = context.MediaUpload;
  return (
    <>
      {galleryOpen && request.gallery && (
        <GalleryDialog
          initial={request.gallery}
          media={context.media}
          Picker={Picker}
          onMediaUpdate={context.onMediaUpdate}
          onClose={() => setGalleryOpen(false)}
          onUpdate={(value) => requestRef.current.select?.(value)}
        />
      )}
      <Picker
        multiple={request.multiple ?? true}
        allowedTypes={request.allowedTypes}
        title="Insert media"
        onSelect={(items: unknown) =>
          requestRef.current.select
            ? requestRef.current.select(items)
            : insertClassicMedia(context.id, items)
        }
        render={({ open: show }: { open: () => void }) => {
          open.current = show;
          return null;
        }}
      />
    </>
  );
}
export function ClassicSupport({
  BlockEdit,
  MediaUpload,
  media,
  onMediaUpdate,
  ...props
}: {
  BlockEdit: ComponentType<any>;
  MediaUpload: ComponentType<any>;
  media: Media[];
  onMediaUpdate?: (item: Media) => void;
  [key: string]: any;
}) {
  const [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0),
    id = `editor-${props.clientId}`,
    open = useRef<OpenMedia>(() => {});
  const bridge = useMemo(
    () => ({ id, MediaUpload, media, onMediaUpdate, open }),
    [id, MediaUpload, media, onMediaUpdate],
  );
  useEffect(() => {
    let active = true;
    const unregister = registerClassicOwner(id, {
      media: (options) => open.current(options),
      status: (message) => {
        if (active) setError(message);
      },
    });
    void ensureClassicRuntime()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error
              ? reason.message
              : "The classic editor could not be loaded.",
          );
      });
    return () => {
      active = false;
      unregister();
    };
  }, [id, retry]);
  if (error)
    return (
      <ClassicStatus>
        <Notice status="error" isDismissible={false}>
          {error}
        </Notice>
        <Button
          variant="secondary"
          onClick={() => {
            setError("");
            setReady(false);
            setRetry((n) => n + 1);
          }}
        >
          Retry classic editor
        </Button>
      </ClassicStatus>
    );
  if (!ready)
    return (
      <ClassicStatus>
        <span role="status">
          <Spinner /> Loading classic editor…
        </span>
      </ClassicStatus>
    );
  return (
    <MediaBridge.Provider value={bridge}>
      <BlockEdit {...props} />
    </MediaBridge.Provider>
  );
}
