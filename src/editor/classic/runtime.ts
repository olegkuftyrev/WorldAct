import * as i18n from "@wordpress/i18n";
import { readClassicGallery, writeClassicGallery } from "./gallery";
import { speak } from "@wordpress/a11y";
import sourceStrings from "./translations.json";
import { classicLinkDialogHTML } from "./linkDialog";
import { classicLinkQuery, classicMediaHTML } from "./content";
import {
  classicState,
  wrapClassicLifecycle,
  type ClassicWindow,
  type ClassicOwner,
} from "./lifecycle";
const root = "/vendor/wordpress";
const tiny = `${root}/wp-includes/js/tinymce`;
function loadScript(win: ClassicWindow, path: string): Promise<void> {
  const state = classicState(win);
  let task = state.scripts.get(path);
  if (task) return task;
  task = new Promise((resolve, reject) => {
    const node = win.document.createElement("script");
    node.src = path;
    node.async = false;
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "The classic editor could not be loaded. Retry to keep editing.",
          ),
        ),
      15000,
    );
    const finish = (error?: Error) => {
      clearTimeout(timer);
      node.onload = node.onerror = null;
      if (error) {
        node.remove();
        state.scripts.delete(path);
        reject(error);
      } else resolve();
    };
    node.onload = () => finish();
    node.onerror = () =>
      finish(
        new Error(
          "The classic editor could not be loaded. Retry to keep editing.",
        ),
      );
    win.document.head.appendChild(node);
  });
  state.scripts.set(path, task);
  return task;
}
function addStyles(win: ClassicWindow) {
  if (win.document.querySelector("link[data-worldact-classic-style]")) return;
  const css = win.document.createElement("link");
  css.rel = "stylesheet";
  css.href = `${root}/wp-includes/css/editor.css`;
  css.dataset.worldactClassicStyle = "";
  win.document.head.appendChild(css);
}
function linkTransport(win: ClassicWindow) {
  const $ = win.jQuery,
    state = classicState(win);
  state.links ||= new Map();
  $.ajaxTransport("+json", (options: any, original: any) => {
    const data =
      typeof original.data === "string"
        ? Object.fromEntries(new URLSearchParams(original.data))
        : original.data;
    if (
      data?.action !== "wp-link-ajax" ||
      new URL(options.url, win.location.href).pathname !==
        "/wp-admin/admin-ajax.php"
    )
      return;
    const abort = new AbortController();
    return {
      send(_headers: any, complete: Function) {
        const id = win.wpActiveEditor || win.tinymce?.activeEditor?.id;
        if (!id || !state.owners.has(id)) {
          complete(200, "success", { json: [] });
          return;
        }
        const pending = state.links.get(id) || new Set<() => void>();
        const cancel = () => {
          abort.abort();
          pending.delete(cancel);
          complete(0, "abort");
        };
        pending.add(cancel);
        state.links.set(id, pending);
        win.document.querySelector("[data-worldact-link-error]")?.remove();
        classicLinkQuery(
          data.search,
          data.page,
          abort.signal,
          win.fetch.bind(win),
        )
          .then((rows) => {
            if (!abort.signal.aborted) complete(200, "success", { json: rows });
          })
          .catch((error) => {
            if (abort.signal.aborted) return;
            const notice = win.document.createElement("p");
            notice.dataset.worldactLinkError = "";
            notice.className = "notice notice-error";
            notice.setAttribute("role", "alert");
            notice.textContent =
              error instanceof Error
                ? error.message
                : "Links could not be loaded. Try searching again.";
            win.document.getElementById("search-panel")?.prepend(notice);
            complete(200, "success", { json: [] });
          })
          .finally(() => {
            pending.delete(cancel);
            if (!pending.size) state.links.delete(id);
          });
      },
      abort() {
        abort.abort();
      },
    };
  });
}
function installMedia(win: ClassicWindow) {
  const state = classicState(win),
    events = new Map<string, Set<Function>>();
  const bus = {
    on(name: string, fn: Function) {
      for (const key of name.split(/\s+/)) {
        if (!events.has(key)) events.set(key, new Set());
        events.get(key)!.add(fn);
      }
      return bus;
    },
    off(name: string, fn?: Function) {
      if (fn) events.get(name)?.delete(fn);
      else events.delete(name);
      return bus;
    },
    trigger(name: string, ...args: any[]) {
      for (const fn of events.get(name) || []) fn(...args);
      return bus;
    },
  };
  // WordPress image tools use the source TinyMCE image dialog when their media
  // frame is unavailable. Keep that genuine dialog behind the callable bridge.
  const media: any = (options: any = {}) => {
    const editor = win.tinymce.get(win.wpActiveEditor),
      listeners = new Map<string, Set<Function>>();
    const trigger = (name: string, ...args: any[]) => {
      for (const fn of [...(listeners.get(name) || [])]) fn(...args);
    };
    let close: Function | undefined;
    const frame: any = {
      on(name: string, fn: Function) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(fn);
        return frame;
      },
      state() {
        return frame;
      },
      detach() {
        if (close) editor?.off("CloseWindow", close);
        listeners.clear();
        return frame;
      },
      open() {
        if (!editor || options.frame !== "image") return frame;
        close = () => {
          trigger("close");
          frame.detach();
        };
        editor.on("CloseWindow", close);
        editor.execCommand("mceImage");
        return frame;
      },
    };
    return frame;
  };
  media.gallery = {
    shortcode: (selection: import("./gallery").ClassicGallery) => ({
      string: () => writeClassicGallery(selection),
    }),
    edit(text: string) {
      const gallery = readClassicGallery(text),
        editor = win.tinymce.activeEditor;
      const listeners = new Set<Function>();
      const frame: any = {
        state: () => frame,
        on: (name: string, fn: Function) => {
          if (name === "update") listeners.add(fn);
          return frame;
        },
        detach: () => listeners.clear(),
      };
      if (gallery && editor)
        state.owners.get(editor.id)?.media({
          gallery,
          select(selection) {
            editor.undoManager.transact(() => {
              for (const fn of listeners) fn(selection);
            });
            editor.focus();
            editor.nodeChanged();
          },
        });
      return frame;
    },
  };
  media.events = bus;
  media.editor = {
    activeEditor: undefined as string | undefined,
    open(id?: string) {
      const target = id || win.wpActiveEditor || win.tinymce.activeEditor?.id;
      if (!target || !state.owners.has(target)) return;
      this.activeEditor = win.wpActiveEditor = target;
      state.owners.get(target)!.media();
    },
    insert(html: string) {
      const id = this.activeEditor || win.wpActiveEditor;
      const editor = id && win.tinymce.get(id);
      if (!editor || !state.owners.has(id!)) return false;
      if (win.send_to_editor) return win.send_to_editor.call(this, html);
      editor.execCommand("mceInsertContent", false, html);
      return true;
    },
  };
  win.wp.media = media;
}
export function registerClassicOwner(
  id: string,
  owner: ClassicOwner,
  win = window as unknown as ClassicWindow,
) {
  const state = classicState(win);
  state.owners.set(id, owner);
  return () => {
    if (state.owners.get(id) === owner) state.owners.delete(id);
  };
}
export function insertClassicMedia(
  id: string,
  items: unknown,
  win = window as unknown as ClassicWindow,
) {
  const editor = win.tinymce?.get(id);
  if (!editor || !classicState(win).owners.has(id)) return;
  const html = (Array.isArray(items) ? items : [items])
    .filter((item) => item && typeof item === "object")
    .map((item) => classicMediaHTML(item))
    .filter(Boolean)
    .join("\n\n");
  if (html)
    editor.undoManager.transact(() => {
      editor.focus();
      if (editor.__worldactMediaBookmark)
        editor.selection.moveToBookmark(editor.__worldactMediaBookmark);
      win.wp.media.editor.activeEditor = win.wpActiveEditor = id;
      win.wp.media.editor.insert(html);
    });
  delete editor.__worldactMediaBookmark;
}
export function prepareClassicMedia(
  id: string,
  win = window as unknown as ClassicWindow,
) {
  const editor = win.tinymce?.get(id);
  if (editor)
    editor.__worldactMediaBookmark = editor.selection.getBookmark(2, true);
}
export async function ensureClassicRuntime(
  win = window as unknown as ClassicWindow,
): Promise<void> {
  const state = classicState(win);
  if (state.promise) return state.promise;
  state.promise = (async () => {
    win.wp ||= {};
    win.wp.i18n = i18n;
    win.wp.a11y = { ...win.wp.a11y, speak };
    addStyles(win);
    if (!win.jQuery)
      await loadScript(win, `${root}/wp-includes/js/jquery/jquery.js`);
    await loadScript(win, `${root}/wp-includes/js/utils.js`);
    if (!win.tinymce) await loadScript(win, `${tiny}/wp-tinymce.js`);
    await loadScript(win, `${tiny}/plugins/image/plugin.min.js`);
    await loadScript(win, `${root}/wp-admin/js/editor.js`);
    const current = await win
      .fetch("/api/session", { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok)
          throw Error(
            "The classic editor could not be loaded. Retry to keep editing.",
          );
        return r.json();
      });
    win.userSettings = {
      url: "/",
      uid: String(current.user.id),
      time: Math.floor(Date.now() / 1000),
      secure: win.location.protocol === "https:",
    };
    const defaults = {
      body_class: "editor-styles-wrapper",
      content_style:
        ".mce-content-body.editor-styles-wrapper{padding:9px 10px;}",
      ui_container: ".block-editor-freeform-modal__content",
      file_picker_types: "image media",
      file_picker_callback(callback: Function, _value: string, meta: any) {
        const editor = win.tinymce.activeEditor;
        if (!editor) return;
        state.owners.get(editor.id)?.media({
          multiple: false,
          allowedTypes:
            meta.filetype === "image" ? ["image"] : ["audio", "video"],
          select(items) {
            const item = Array.isArray(items) ? items[0] : items;
            if (item && typeof item === "object") {
              const media = item as Record<string, any>;
              callback(media.url, {
                alt: media.alt || media.alt_text || "",
                title: typeof media.title === "string" ? media.title : "",
              });
            }
          },
        });
      },
      theme: "modern",
      skin: "lightgray",
      language: "en",
      relative_urls: false,
      remove_script_host: false,
      convert_urls: false,
      browser_spellcheck: true,
      fix_list_elements: true,
      entities: "38,amp,60,lt,62,gt",
      entity_encoding: "raw",
      keep_styles: false,
      resize: "vertical",
      menubar: false,
      branding: false,
      preview_styles:
        "font-family font-size font-weight font-style text-decoration text-transform",
      end_container_on_empty_block: true,
      wpeditimage_html5_captions: true,
      wp_lang_attr: "en-US",
      wp_shortcut_labels: sourceStrings.shortcuts,
      wpautop: false,
      indent: true,
      elementpath: false,
      content_css: `${root}/wp-includes/css/dashicons.css,${root}/wp-includes/js/tinymce/skins/wordpress/wp-content.css`,
      formats: {
        alignleft: [
          {
            selector: "p,h1,h2,h3,h4,h5,h6,td,th,div,ul,ol,li",
            styles: { textAlign: "left" },
          },
          { selector: "img,table,dl.wp-caption", classes: "alignleft" },
        ],
        aligncenter: [
          {
            selector: "p,h1,h2,h3,h4,h5,h6,td,th,div,ul,ol,li",
            styles: { textAlign: "center" },
          },
          { selector: "img,table,dl.wp-caption", classes: "aligncenter" },
        ],
        alignright: [
          {
            selector: "p,h1,h2,h3,h4,h5,h6,td,th,div,ul,ol,li",
            styles: { textAlign: "right" },
          },
          { selector: "img,table,dl.wp-caption", classes: "alignright" },
        ],
        strikethrough: { inline: "del" },
      },
    };
    const settings = {
      plugins:
        "charmap,colorpicker,hr,lists,media,paste,tabfocus,textcolor,fullscreen,wordpress,wpautoresize,wpeditimage,wpemoji,wpgallery,wplink,wpdialogs,wptextpattern,wpview,image",
      toolbar1:
        "formatselect,bold,italic,bullist,numlist,blockquote,alignleft,aligncenter,alignright,link,unlink,wp_more,spellchecker,wp_add_media,wp_adv",
      toolbar2:
        "strikethrough,hr,forecolor,pastetext,removeformat,charmap,outdent,indent,undo,redo,wp_help",
      toolbar3: "",
      toolbar4: "",
      external_plugins: {},
      classic_block_editor: true,
      image_advtab: true,
      image_title: true,
      image_caption: true,
    };
    win.wp.editor.getDefaultSettings = () => ({
      tinymce: { ...defaults },
      quicktags: { buttons: "strong,em,link,ul,ol,li,code" },
    });
    win.wp.oldEditor = wrapClassicLifecycle(win, win.wp.editor);
    win.wpEditorL10n = { tinymce: { baseURL: tiny, suffix: ".min", settings } };
    win.tinyMCEPreInit = {
      baseURL: tiny,
      suffix: ".min",
      mceInit: {},
      qtInit: {},
    };
    win.tinymce.addI18n("en", sourceStrings.translations);
    installMedia(win);
    for (const name of ["core", "menu", "autocomplete"])
      await loadScript(win, `${root}/wp-includes/js/jquery/ui/${name}.js`);
    // Keep autocomplete within the genuine Classic dialog focus/ARIA scope.
    win.jQuery.ui.autocomplete.prototype.options.appendTo =
      ".block-editor-freeform-modal__content";
    if (!win.document.getElementById("wp-link-wrap")) {
      const holder = win.document.createElement("div");
      holder.innerHTML = classicLinkDialogHTML;
      win.document.body.append(...holder.childNodes);
    }
    win.ajaxurl = "/wp-admin/admin-ajax.php";
    win.wpLinkL10n = {
      title: "Insert/edit link",
      update: "Update",
      save: "Add Link",
      noTitle: "(no title)",
      noMatchesFound: "No results found.",
      linkSelected: "Link selected.",
      linkInserted: "Link inserted.",
      minInputLength: "3",
    };
    linkTransport(win);
    await loadScript(win, `${root}/wp-includes/js/wplink.js`);
  })().catch((error) => {
    state.promise = undefined;
    throw error;
  });
  return state.promise;
}
