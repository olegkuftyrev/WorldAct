export type ClassicMediaRequest = {
  multiple?: boolean;
  allowedTypes?: string[];
  select?: (items: unknown) => void;
  gallery?: import("./gallery").ClassicGallery;
};
export type ClassicOwner = {
  media: (request?: ClassicMediaRequest) => void;
  status: (error: string) => void;
};
export type ClassicWindow = Window & {
  wp: any;
  tinymce: any;
  jQuery: any;
  wpEditorL10n: any;
  wpLink?: any;
  wpLinkL10n?: any;
  wpActiveEditor?: string;
  send_to_editor?: Function;
  userSettings?: any;
  tinyMCEPreInit?: any;
  ajaxurl?: string;
  __worldActClassic?: ClassicState;
};
export type ClassicState = {
  promise?: Promise<void>;
  scripts: Map<string, Promise<void>>;
  owners: Map<string, ClassicOwner>;
  links: Map<string, Set<() => void>>;
  instances: Map<
    string,
    {
      editor?: any;
      removed: boolean;
      timer: ReturnType<typeof setTimeout>;
      previous?: string;
    }
  >;
};
export function classicState(win: ClassicWindow): ClassicState {
  return (win.__worldActClassic ||= {
    scripts: new Map(),
    owners: new Map(),
    links: new Map(),
    instances: new Map(),
  });
}
/** Keep the actual source API; compose its per-instance setup and cleanup. */
export function wrapClassicLifecycle(
  win: ClassicWindow,
  source: any,
  timeout = 15000,
) {
  const state = classicState(win);
  return {
    ...source,
    initialize(id: string, settings: any) {
      const target = win.document.getElementById(id);
      if (!target) return;
      if (state.instances.has(id)) this.remove(id);
      const entry = {
        removed: false,
        editor: undefined as any,
        previous: win.wpActiveEditor,
        timer: setTimeout(() => {
          if (state.instances.get(id) !== entry) return;
          this.remove(id);
          state.owners
            .get(id)
            ?.status(
              "The classic editor could not be loaded. Retry to keep editing.",
            );
        }, timeout),
      };
      state.instances.set(id, entry);
      const setup = settings?.tinymce?.setup;
      try {
        source.initialize(id, {
          ...settings,
          tinymce: {
            ...settings.tinymce,
            setup(editor: any) {
              entry.editor = editor;
              editor.on("init", () => {
                clearTimeout(entry.timer);
                if (entry.removed || !target.isConnected) {
                  if (!editor.removed) editor.remove();
                  return;
                }
                state.owners.get(id)?.status("");
              });
              setup?.(editor);
            },
          },
        });
      } catch {
        this.remove(id);
        state.owners
          .get(id)
          ?.status(
            "The classic editor could not be loaded. Retry to keep editing.",
          );
      }
    },
    remove(id: string) {
      const entry = state.instances.get(id);
      if (entry) {
        entry.removed = true;
        clearTimeout(entry.timer);
      }
      if (win.wpActiveEditor === id && win.wpLink?.modalOpen)
        win.wpLink.close();
      for (const abort of state.links?.get(id) || []) abort();
      state.links?.delete(id);
      const registered = win.tinymce.get(id);
      source.remove(id);
      if (entry?.editor && entry.editor !== registered && !entry.editor.removed)
        entry.editor.remove();
      state.instances.delete(id);
      if (win.wp?.media?.editor?.activeEditor === id)
        win.wp.media.editor.activeEditor = undefined;
      if (win.wpActiveEditor === id)
        win.wpActiveEditor =
          entry?.previous && win.tinymce.get(entry.previous)
            ? entry.previous
            : undefined;
    },
    getContent(id: string) {
      return source.getContent(id);
    },
  };
}
