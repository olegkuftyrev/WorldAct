export type MediaUpdate = { id: number; url?: string };
export type MediaModalOptions = {
  id: number;
  onUpdate?: (value: MediaUpdate) => unknown;
  onUndo?: () => void;
  onClose?: () => void;
};
type Adapter = {
  open: (options: MediaModalOptions) => void;
  close: () => void;
  currentUpdate: () => unknown;
};

/** A source modal is global; a removed editor must never close another owner's modal. */
export function createMediaModalOwner(adapter: Adapter) {
  let current: MediaModalOptions | null = null;
  const owns = (update: unknown) => !!current && current.onUpdate === update;
  const dispose = () => {
    const previous = current;
    current = null;
    if (previous && adapter.currentUpdate() === previous.onUpdate) {
      adapter.close();
      previous.onClose?.();
    }
  };
  return {
    owns,
    dispose,
    open(options: MediaModalOptions) {
      dispose();
      let closed = false;
      const owned: MediaModalOptions = {
        ...options,
        onUpdate: (value) => {
          if (!closed && current === owned) return options.onUpdate?.(value);
        },
        onClose: () => {
          if (closed) return;
          closed = true;
          if (current === owned) current = null;
          options.onClose?.();
        },
      };
      current = owned;
      adapter.open(owned);
    },
  };
}
