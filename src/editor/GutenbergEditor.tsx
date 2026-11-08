import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  createElement,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  BlockBreadcrumb,
  BlockContextProvider,
  store as blockEditorStore,
  BlockCanvas,
  BlockEditorProvider,
  BlockInspector,
  BlockToolbar,
  Inserter,
  useBlockProps,
  __experimentalLibrary as InserterLibrary,
  __experimentalListView as ListView,
} from "@wordpress/block-editor";
import {
  createBlock,
  getBlockType,
  getBlockBindingsSource,
  registerBlockBindingsSource,
  getBlockVariations,
  parse,
  rawHandler,
  registerBlockType,
  unregisterBlockVariation,
  serialize,
  type Block,
} from "@wordpress/blocks";
import { registerCoreBlocks } from "@wordpress/block-library";
import {
  Button,
  Modal,
  Notice,
  Popover,
  SlotFillProvider,
} from "@wordpress/components";
import { addFilter } from "@wordpress/hooks";
import apiFetch from "@wordpress/api-fetch";
import {
  getSettings as getDateSettings,
  setSettings as setDateSettings,
} from "@wordpress/date";
import { dispatch, select, useSelect } from "@wordpress/data";
import { store as coreDataStore } from "@wordpress/core-data";
import "@wordpress/format-library";
import "@wordpress/components/build-style/style.css";
import "@wordpress/block-editor/build-style/style.css";
import "@wordpress/block-library/build-style/editor.css";
// The format-library package does not export its CSS subpath.
import "../../node_modules/@wordpress/format-library/build-style/style.css";
import libraryCSS from "@wordpress/block-library/build-style/style.css?inline";
import libraryEditorCSS from "@wordpress/block-library/build-style/editor.css?inline";
import editorContentCSS from "@wordpress/block-editor/build-style/content.css?inline";
import themeCSS from "@wordpress/block-library/build-style/theme.css?inline";
import formatCSS from "../../node_modules/@wordpress/format-library/build-style/style.css?inline";
import { api, type Media } from "../api";
import type { SerializedBlock } from "./types";
import { parseVideoEmbed } from "../embeds";
import { compileThemeStyles, type ThemeJSON, type ThemeStyleOverrides } from "../themeStyles";
import "./gutenberg.css";

export type { SerializedBlock, GutenbergBlock } from "./types";

// These blocks serialize complete, usable markup without a WordPress/PHP renderer.
// Query, navigation and other entity-backed blocks belong to the site renderer.
export const WORLDAct_CONTENT_BLOCKS = [
  "core/paragraph",
  "core/heading",
  "core/list",
  "core/list-item",
  "core/quote",
  "core/pullquote",
  "core/preformatted",
  "core/code",
  "core/table",
  "core/verse",
  "core/image",
  "core/gallery",
  "core/cover",
  "core/media-text",
  "core/audio",
  "core/video",
  "core/file",
  "core/buttons",
  "core/button",
  "core/separator",
  "core/spacer",
  "core/columns",
  "core/column",
  "core/group",
  "core/details",
  "core/html",
  "core/embed",
];

export const WORLDAct_DYNAMIC_BLOCKS = [
  "core/query",
  "core/post-template",
  "core/post-title",
  "core/post-content",
  "core/post-excerpt",
  "core/post-date",
  "core/post-author",
  "core/post-author-name",
  "core/post-author-biography",
  "core/post-featured-image",
  "core/post-terms",
  "core/read-more",
  "core/query-pagination",
  "core/query-pagination-next",
  "core/query-pagination-previous",
  "core/query-pagination-numbers",
  "core/query-no-results",
  "core/query-title",
  "core/block",
  "core/term-description",
  "core/avatar",
  "core/post-navigation-link",
  "core/search",
  "core/social-links",
  "core/social-link",
  "core/comments",
  "core/comments-title",
  "core/comment-template",
  "core/comment-date",
  "core/comment-author-name",
  "core/comment-content",
  "core/comment-edit-link",
  "core/comment-reply-link",
  "core/comments-pagination",
  "core/comments-pagination-previous",
  "core/comments-pagination-numbers",
  "core/comments-pagination-next",
  "core/post-comments-form",
  "core/categories",
];
export const WORLDAct_SITE_BLOCKS = [
  "core/site-title",
  "core/site-tagline",
  "core/site-logo",
  "core/navigation",
  "core/navigation-link",
  "core/navigation-submenu",
  "core/page-list",
  "core/home-link",
  "core/template-part",
  "core/pattern",
];

if (!getBlockType("core/paragraph")) registerCoreBlocks();
if (!getBlockBindingsSource("core/post-data"))
  registerBlockBindingsSource({
    name: "core/post-data",
    label: "Post data",
    usesContext: ["postId", "postType", "queryId"],
    getValues: ({ select, context, bindings, clientId }: any) => {
      const attrs = select(blockEditorStore).getBlockAttributes(clientId) || {};
      const id = attrs.kind === "post-type" ? attrs.id : context.postId,
        type = attrs.kind === "post-type" ? attrs.type : context.postType;
      const record =
        id && type
          ? select(coreDataStore).getEditedEntityRecord("postType", type, id)
          : null;
      const values: Record<string, unknown> = {};
      for (const [key, binding] of Object.entries(bindings) as any) {
        const field = binding.args?.field;
        if (["date", "modified", "link", "title", "excerpt"].includes(field)) {
          const value = record?.[field];
          values[key] =
            typeof value === "object" && value !== null
              ? (value.raw ?? value.rendered)
              : value;
        }
      }
      return values;
    },
    setValues: ({ dispatch, context, bindings }: any) => {
      if (
        !context.postId ||
        !context.postType ||
        Number.isFinite(context.queryId)
      )
        return;
      const edits: Record<string, unknown> = {};
      for (const binding of Object.values(bindings) as any) {
        if (
          ["date", "modified", "title", "excerpt"].includes(binding.args?.field)
        )
          edits[binding.args.field] = binding.newValue;
      }
      if (Object.keys(edits).length)
        dispatch(coreDataStore).editEntityRecord(
          "postType",
          context.postType,
          context.postId,
          edits,
        );
    },
    canUserEditValue: ({ select, context }: any) =>
      !Number.isFinite(context.queryId) &&
      !!context.postId &&
      !!select(coreDataStore).canUser("update", {
        kind: "postType",
        name: context.postType,
        id: context.postId,
      }),
  });

for (const variation of getBlockVariations("core/embed") || []) {
  if (!["youtube", "vimeo"].includes(variation.name))
    unregisterBlockVariation("core/embed", variation.name);
}

const siteBindings = [
  {
    name: "site-title",
    title: "Site Title",
    token: "siteTitle",
    tag: "div",
    className: "site-title",
    preview: "Your site title",
  },
  {
    name: "tagline",
    title: "Site Tagline",
    token: "tagline",
    tag: "p",
    className: "site-tagline",
    preview: "Your site tagline",
  },
  {
    name: "navigation",
    title: "Navigation",
    token: "navigation",
    tag: "nav",
    className: "site-navigation",
    preview: "Your navigation menu",
  },
  {
    name: "post-title",
    title: "Post Title",
    token: "postTitle",
    tag: "h1",
    className: "post-title",
    preview: "Your post title",
  },
  {
    name: "post-content",
    title: "Post Content",
    token: "content",
    tag: "div",
    className: "public-content",
    preview: "The content of each post or page appears here.",
  },
  {
    name: "post-date",
    title: "Post Date",
    token: "postDate",
    tag: "span",
    className: "post-date",
    preview: "Publication date",
  },
  {
    name: "post-author",
    title: "Post Author",
    token: "postAuthor",
    tag: "span",
    className: "post-author",
    preview: "Author name",
  },
  {
    name: "post-list",
    title: "Posts",
    token: "postList",
    tag: "div",
    className: "post-list",
    preview: "Your published posts appear here.",
  },
];
for (const binding of siteBindings) {
  const name = `worldact/${binding.name}`;
  if (!getBlockType(name))
    registerBlockType(name, {
      apiVersion: 3,
      title: binding.title,
      category: "theme",
      icon: "admin-site",
      attributes: {},
      supports: {
        html: false,
        inserter: false,
        align: true,
        color: { text: true, background: true },
        typography: { fontSize: true },
        spacing: { margin: true, padding: true },
      },
      edit: function SiteBindingEdit() {
        return createElement(
          binding.tag,
          useBlockProps({ className: "worldact-binding-preview" }),
          createElement(
            "span",
            { className: "worldact-binding-label" },
            binding.title,
          ),
          createElement(
            "span",
            { className: "worldact-binding-content" },
            binding.preview,
          ),
        );
      },
      save: function SiteBindingSave() {
        return createElement(
          binding.tag,
          useBlockProps.save({ className: binding.className }),
          `{{${binding.token}}}`,
        );
      },
    });
}

type Attachment = Record<string, unknown>;
type MediaUploadOptions = {
  filesList: ArrayLike<File>;
  allowedTypes?: string[];
  multiple?: boolean;
  onFileChange?: (files: Attachment[]) => void;
  onSuccess?: (files: Attachment[]) => void;
  onError?: (message: string) => void;
};
type MediaAdapter = {
  media: Media[];
  upload: (files: File[]) => Promise<Media[]>;
  onError: (message: string) => void;
};
const MediaContext = createContext<MediaAdapter | null>(null);

function mediaMatches(item: Media, allowedTypes?: string[]) {
  return (
    !allowedTypes?.length ||
    allowedTypes.some(
      (type) =>
        item.mimeType === type ||
        item.mimeType.startsWith(`${type.replace(/\/\*$/, "")}/`),
    )
  );
}

function attachment(item: Media, rest = false): Attachment {
  const dimensions = item as Media & {
    width?: number | null;
    height?: number | null;
  };
  const full = {
    url: item.url,
    source_url: item.url,
    width: dimensions.width || undefined,
    height: dimensions.height || undefined,
    mime_type: item.mimeType,
  };
  const sizes = {
    full,
    ...Object.fromEntries(
      Object.entries(item.sizes || {}).map(([name, size]) => [
        name,
        {
          ...size,
          source_url: size.url,
          mime_type: size.mimeType,
        },
      ]),
    ),
  };
  return {
    id: item.id,
    url: item.url,
    src: item.url,
    source_url: item.url,
    title: rest ? { raw: item.title, rendered: item.title } : item.title,
    caption: rest
      ? { raw: item.caption, rendered: item.caption }
      : item.caption,
    description: { raw: "", rendered: "" },
    alt: item.alt,
    alt_text: item.alt,
    mime: item.mimeType,
    mime_type: item.mimeType,
    type: item.mimeType.split("/")[0],
    media_type: item.mimeType.startsWith("image/") ? "image" : "file",
    subtype: item.mimeType.split("/")[1],
    filesize: item.size,
    filename: item.filename,
    width: dimensions.width || undefined,
    height: dimensions.height || undefined,
    sizes,
    media_details: {
      width: dimensions.width || undefined,
      height: dimensions.height || undefined,
      sizes,
    },
    link: item.url,
  };
}

// Core image and gallery blocks also read attachment entities. Adapt only this
// narrow endpoint to our real Node API; no WordPress server is required.
apiFetch.use(async (options, next) => {
  const path = options.path;
  if (path && /^\/?oembed\/1\.0\/proxy(?:\?|$)/.test(path)) {
    const target = new URL(path, window.location.origin);
    const embed = parseVideoEmbed(target.searchParams.get("url") || "");
    if (!embed)
      throw {
        code: "oembed_invalid_url",
        message: "Enter a YouTube or Vimeo video link.",
        data: { status: 400 },
      };
    return {
      version: "1.0",
      type: "video",
      provider_name: embed.provider,
      provider_url:
        embed.provider === "YouTube"
          ? "https://www.youtube.com"
          : "https://vimeo.com",
      title: embed.title,
      width: embed.width,
      height: embed.height,
      html: `<iframe src="${embed.src.replace(/&/g, "&amp;")}" title="${embed.title}" width="${embed.width}" height="${embed.height}" allow="encrypted-media; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`,
    };
  }
  if (!path || !/^\/?wp\/v2\/media(?:\/\d+)?(?:\?|$)/.test(path)) {
    if (
      !path ||
      !(
        path === "/" ||
        path.startsWith("/?") ||
        /^\/?(?:wp\/v2|wp-block-editor\/v1)\//.test(path)
      )
    )
      return next(options);
    const target = new URL(
      path.startsWith("/?")
        ? "/wp-json" + path
        : path === "/"
          ? "/wp-json/"
          : "/wp-json/" + path.replace(/^\//, ""),
      window.location.origin,
    );
    if (
      /\/wp\/v2\/(posts|pages)$/.test(target.pathname) &&
      options.method !== "POST"
    )
      target.searchParams.set("has_password", "false");
    let data = options.data;
    const entityPath = target.pathname.match(
      /^\/wp-json\/wp\/v2\/(navigation|blocks|template-parts)\/(.+)$/,
    );
    if (
      entityPath &&
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      ["POST", "PUT", "PATCH"].includes(
        (options.method || "GET").toUpperCase(),
      ) &&
      !(data as any).version
    ) {
      const name =
        entityPath[1] === "navigation"
          ? "wp_navigation"
          : entityPath[1] === "blocks"
            ? "wp_block"
            : "wp_template_part";
      const id =
        name === "wp_template_part"
          ? decodeURIComponent(entityPath[2])
          : Number(entityPath[2]);
      const record = select(coreDataStore).getEntityRecord(
        "postType",
        name,
        id,
      ) as { version?: number } | undefined;
      if (record?.version) data = { ...data, version: record.version };
    }
    // Continue through the official fetch-all middleware: per_page=-1 must
    // follow every REST Link page, while parse:false retains native headers.
    return next({ ...options, path: undefined, url: target.href, data });
  }
  if (
    options.method &&
    !["GET", "OPTIONS"].includes(options.method.toUpperCase())
  )
    return next(options);
  const target = new URL(path, window.location.origin);
  const { media } = await api<{ media: Media[] }>("/media");
  const id = target.pathname.match(/\/(\d+)$/)?.[1];
  const include = target.searchParams.get("include")?.split(",").map(Number);
  const search = target.searchParams.get("search")?.toLowerCase();
  let records = media.filter(
    (item) =>
      (!include || include.includes(item.id)) &&
      (!search ||
        `${item.title} ${item.filename}`.toLowerCase().includes(search)),
  );
  const mime = target.searchParams.get("media_type");
  if (mime)
    records = records.filter((item) => item.mimeType.startsWith(`${mime}/`));
  const selected = id
    ? records.find((item) => item.id === Number(id))
    : undefined;
  if (id && !selected)
    throw {
      code: "rest_media_invalid_id",
      message: "Media item not found.",
      data: { status: 404 },
    };
  const result = id
    ? attachment(selected!, true)
    : records.map((item) => attachment(item, true));
  if (options.parse === false) {
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "X-WP-Total": String(records.length),
        "X-WP-TotalPages": "1",
        Allow: "GET, POST, PUT, DELETE",
      },
    });
  }
  return result;
});

dispatch(coreDataStore).addEntities([
  {
    kind: "postType",
    name: "attachment",
    label: "Media",
    baseURL: "/wp/v2/media",
    baseURLParams: { context: "edit" },
    supportsPagination: true,
    rawAttributes: ["title", "caption", "description"],
  },
  {
    kind: "postType",
    name: "wp_template_part",
    label: "Template Parts",
    baseURL: "/wp/v2/template-parts",
    baseURLParams: { context: "edit" },
    supportsPagination: false,
    rawAttributes: ["title", "content"],
    transientEdits: {
      blocks: {
        read: (record: any) => parse(record.content?.raw || ""),
        write: (record: any) => ({ content: serialize(record.blocks) }),
      },
    },
    getTitle: (record: any) =>
      record.title?.rendered || record.title?.raw || record.slug,
  },
]);

type MediaUploadProps = {
  allowedTypes?: string[];
  multiple?: boolean | string;
  value?: number | number[];
  title?: string;
  onClose?: () => void;
  onSelect: (media: unknown) => void;
  render: (props: { open: () => void }) => ReactNode;
};

function WorldActMediaUpload({
  allowedTypes,
  multiple,
  value,
  title,
  onClose,
  onSelect,
  render,
}: MediaUploadProps) {
  const adapter = useContext(MediaContext);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!adapter) return null;
  const available = adapter.media.filter((item) =>
    mediaMatches(item, allowedTypes),
  );
  const visible = available.filter((item) =>
    `${item.title} ${item.filename}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const close = () => {
    setOpen(false);
    onClose?.();
  };
  const selectedMedia = available.filter((item) => selected.includes(item.id));
  async function upload(files: File[]) {
    if (!files.length || !adapter) return;
    setBusy(true);
    setError("");
    try {
      const uploaded = await adapter.upload(
        multiple ? files : files.slice(0, 1),
      );
      setSelected(
        uploaded
          .filter((item) => mediaMatches(item, allowedTypes))
          .map((item) => item.id),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The upload could not be completed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {render({
        open: () => {
          setSelected(Array.isArray(value) ? value : value ? [value] : []);
          setError("");
          setOpen(true);
        },
      })}
      {open && (
        <Modal
          title={title || "Select or upload media"}
          onRequestClose={close}
          className="worldact-block-media-modal"
          size="large"
        >
          <div className="worldact-block-media-tools">
            <label className="worldact-block-upload-button">
              <span className="button">
                {busy ? "Uploading…" : "Upload files"}
              </span>
              <input
                type="file"
                disabled={busy}
                multiple={!!multiple}
                accept={allowedTypes
                  ?.map((type) => (type.includes("/") ? type : `${type}/*`))
                  .join(",")}
                onChange={(event) => {
                  void upload(Array.from(event.currentTarget.files || []));
                  event.currentTarget.value = "";
                }}
              />
            </label>
            <label>
              Search media{" "}
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
          </div>
          {error && (
            <Notice status="error" isDismissible onRemove={() => setError("")}>
              {error}
            </Notice>
          )}
          <div
            className="worldact-block-media-grid"
            role="group"
            aria-label="Media library"
          >
            {visible.map((item) => (
              <button
                type="button"
                key={item.id}
                aria-pressed={selected.includes(item.id)}
                className={selected.includes(item.id) ? "is-selected" : ""}
                onClick={() => {
                  setSelected((current) =>
                    multiple
                      ? current.includes(item.id)
                        ? current.filter((id) => id !== item.id)
                        : [...current, item.id]
                      : [item.id],
                  );
                }}
              >
                {item.mimeType.startsWith("image/") ? (
                  <img src={item.url} alt={item.alt || item.title} />
                ) : (
                  <span className="worldact-block-file-icon" aria-hidden="true">
                    ▤
                  </span>
                )}
                <span>{item.title}</span>
              </button>
            ))}
            {!visible.length && (
              <p>No matching media. Upload a file to add it to your library.</p>
            )}
          </div>
          <div className="worldact-block-media-actions">
            <span>{selectedMedia.length} selected</span>
            <Button
              variant="primary"
              disabled={!selectedMedia.length || busy}
              onClick={() => {
                const result = selectedMedia.map((item) => attachment(item));
                close();
                onSelect(multiple ? result : result[0]);
              }}
            >
              Select
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

addFilter(
  "editor.MediaUpload",
  "worldact/native-media-library",
  () => WorldActMediaUpload,
);

function toStored(blocks: Block[]): SerializedBlock[] {
  return blocks.map((block) => ({
    name: block.name,
    // RichTextData implements toJSON; this also detaches Gutenberg's mutable data.
    attributes: JSON.parse(JSON.stringify(block.attributes)) as Record<
      string,
      unknown
    >,
    innerBlocks: toStored(block.innerBlocks || []),
  }));
}

function restoreBlocks(blocks: SerializedBlock[]): Block[] {
  return blocks.map((block) => {
    // Earlier documents keep working while their next visual save adopts the
    // corresponding genuine core entity-backed blocks.
    const legacy: Record<string, [string, Record<string, unknown>]> = {
      "worldact/site-title": [
        "core/site-title",
        { level: 0, isLink: true, className: "site-title" },
      ],
      "worldact/tagline": ["core/site-tagline", { className: "site-tagline" }],
      "worldact/navigation": ["core/navigation", {}],
      "worldact/post-title": [
        "core/post-title",
        { level: 1, className: "post-title" },
      ],
      "worldact/post-content": [
        "core/post-content",
        { className: "public-content" },
      ],
      "worldact/post-date": ["core/post-date", { className: "post-date" }],
      "worldact/post-author": [
        "core/post-author-name",
        { className: "post-author" },
      ],
    };
    const replacement = legacy[block.name];
    if (replacement)
      block = {
        ...block,
        name: replacement[0],
        attributes: { ...replacement[1], ...block.attributes },
      };
    if (block.name === "worldact/post-list")
      return createBlock(
        "core/query",
        {
          queryId: 0,
          query: {
            perPage: 10,
            postType: "post",
            order: "desc",
            orderBy: "date",
            inherit: true,
          },
        },
        [
          createBlock("core/post-template", {}, [
            createBlock("core/post-title", { level: 2, isLink: true }),
            createBlock("core/post-excerpt"),
          ]),
          createBlock("core/query-pagination", {}, [
            createBlock("core/query-pagination-previous"),
            createBlock("core/query-pagination-numbers"),
            createBlock("core/query-pagination-next"),
          ]),
          createBlock("core/query-no-results", {}, [
            createBlock("core/paragraph", { content: "No posts found." }),
          ]),
        ],
      );
    if (
      block.name === "core/post-date" &&
      !block.attributes.datetime &&
      !(block.attributes.metadata as any)?.bindings?.datetime
    ) {
      block = {
        ...block,
        attributes: {
          ...block.attributes,
          metadata: {
            ...(block.attributes.metadata as any),
            bindings: {
              datetime: {
                source: "core/post-data",
                args: {
                  field: (block.attributes as any).displayModified
                    ? "modified"
                    : "date",
                },
              },
            },
          },
        },
      };
    }
    if (!getBlockType(block.name)) {
      // Preserve an unknown block's data in the official recovery block.
      const attrs = JSON.stringify(block.attributes).replace(/</g, "\\u003c");
      const originalContent = `<!-- wp:${block.name} ${attrs} /-->`;
      return createBlock("core/missing", {
        originalName: block.name,
        originalContent,
      });
    }
    return createBlock(
      block.name,
      block.attributes,
      restoreBlocks(block.innerBlocks || []),
    );
  });
}

function initialValue(blocks: SerializedBlock[] | null, html: string): Block[] {
  // The official parser also recovers RichText and media attributes from saved
  // markup. The server's structural parser deliberately does not extract them.
  const value = html.includes("<!-- wp:")
    ? restoreBlocks(toStored(parse(html)))
    : blocks?.length
      ? restoreBlocks(blocks)
      : html.trim()
        ? rawHandler({ HTML: html })
        : [];
  return value.length ? value : [createBlock("core/paragraph")];
}

const canvasCSS = `
:root { --wp--style--global--content-size: 680px; --wp--style--global--wide-size: 1120px; --wp--preset--color--base: #fff; --wp--preset--color--contrast: #111; --wp--preset--color--accent-1: #ffee58; --wp--preset--color--accent-2: #f6cff4; --wp--preset--color--accent-3: #503aa8; --wp--preset--font-size--small: 14px; --wp--preset--font-size--medium: 20px; --wp--preset--font-size--large: 36px; --wp--preset--font-size--x-large: 48px; --wp--preset--font-size--xx-large: 64px; --wp--preset--spacing--20: 10px; --wp--preset--spacing--30: 20px; --wp--preset--spacing--40: 30px; --wp--preset--spacing--50: 40px; --wp--preset--spacing--60: 60px; --wp--preset--spacing--70: 80px; --wp--preset--spacing--80: 120px; }
body { margin: 0; color: #1e1e1e; background: #fff; font-family: Georgia, 'Times New Roman', serif; font-size: 20px; line-height: 1.6; }
body.editor-styles-wrapper { padding: 36px 32px 120px; box-sizing: border-box; }
.editor-styles-wrapper .is-root-container > :where(.wp-block):not(.alignwide):not(.alignfull), .editor-styles-wrapper .block-editor-default-block-appender { max-width: 680px; margin-inline: auto; }
.editor-styles-wrapper .is-root-container > .alignwide { max-width: 1120px; margin-inline: auto; }
.editor-styles-wrapper .is-root-container > .alignfull { max-width: none; }
.editor-styles-wrapper :where(h1,h2,h3,h4,h5,h6) { line-height: 1.2; font-weight: 400; }
.editor-styles-wrapper .wp-block { margin-top: 24px; margin-bottom: 24px; }
.editor-styles-wrapper .wp-block-button__link { border-radius: 0; background-color: #111; color: #fff; }
.editor-styles-wrapper .wp-block-image img { max-width: 100%; height: auto; }
.editor-styles-wrapper .wp-block-table table { border-collapse: collapse; width: 100%; }
.has-base-color { color: var(--wp--preset--color--base); } .has-base-background-color { background-color: var(--wp--preset--color--base); } .has-contrast-color { color: var(--wp--preset--color--contrast); } .has-contrast-background-color { background-color: var(--wp--preset--color--contrast); } .has-accent-1-color { color: var(--wp--preset--color--accent-1); } .has-accent-1-background-color { background-color: var(--wp--preset--color--accent-1); } .has-accent-2-color { color: var(--wp--preset--color--accent-2); } .has-accent-2-background-color { background-color: var(--wp--preset--color--accent-2); } .has-accent-3-color { color: var(--wp--preset--color--accent-3); } .has-accent-3-background-color { background-color: var(--wp--preset--color--accent-3); }
.has-small-font-size { font-size: var(--wp--preset--font-size--small); } .has-medium-font-size { font-size: var(--wp--preset--font-size--medium); } .has-large-font-size { font-size: var(--wp--preset--font-size--large); } .has-x-large-font-size { font-size: var(--wp--preset--font-size--x-large); } .has-xx-large-font-size { font-size: var(--wp--preset--font-size--xx-large); }
.worldact-binding-preview { border: 1px dashed #c3c4c7; padding: 20px; min-height: 64px; box-sizing: border-box; } .worldact-binding-label { display: block; font: 500 11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif; text-transform: uppercase; color: #646970; margin-bottom: 8px; } .worldact-binding-content { display: block; }
.editor-styles-wrapper .wp-has-aspect-ratio .wp-block-embed__wrapper::before { content: ""; display: block; padding-top: 56.25%; }
.editor-styles-wrapper .wp-has-aspect-ratio iframe.components-sandbox { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
@media(max-width:600px) { body.editor-styles-wrapper { padding: 20px 20px 100px; } body { font-size: 18px; } }
`;
const canvasStyles = [
  { css: libraryCSS },
  { css: libraryEditorCSS },
  { css: editorContentCSS },
  { css: themeCSS },
  { css: formatCSS },
  { css: canvasCSS },
];
const colors = [
  { name: "Base", slug: "base", color: "#ffffff" },
  { name: "Contrast", slug: "contrast", color: "#111111" },
  { name: "Accent 1", slug: "accent-1", color: "#ffee58" },
  { name: "Accent 2", slug: "accent-2", color: "#f6cff4" },
  { name: "Accent 3", slug: "accent-3", color: "#503aa8" },
];

export type GutenbergEditorHandle = {
  undo: () => void;
  redo: () => void;
  getBlocks: () => SerializedBlock[];
  getHTML: () => string;
  insertBlocks: (blocks: SerializedBlock[]) => void;
  flushEntities: () => Promise<void>;
};
export type GutenbergEditorProps = {
  initialBlocks: SerializedBlock[] | null;
  initialHTML: string;
  resetKey: string | number;
  onChange: (blocks: SerializedBlock[], html: string) => void;
  media: Media[];
  onUpload?: (files: File[]) => Promise<Media[]>;
  onError?: (message: string) => void;
  inserterOpen?: boolean;
  listViewOpen?: boolean;
  inspectorOpen?: boolean;
  canvasCSS?: string;
  context?: "post" | "site";
  postId?: number;
  postType?: "post" | "page";
  hidePatternManager?: boolean;
};

function UndoIcon({ redo = false }: { redo?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      aria-hidden="true"
      style={redo ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M8 7v-3L2.5 9.5 8 15v-3h6a4 4 0 0 1 0 8h-3v1.5h3a5.5 5.5 0 0 0 0-11H8V7Z"
        fill="currentColor"
      />
    </svg>
  );
}

function EntityEditsObserver({ onDirty }: { onDirty: () => void }) {
  const changes = useSelect(
    (select) =>
      JSON.stringify(
        select(coreDataStore)
          .__experimentalGetDirtyEntityRecords()
          .map((record) => ({
            kind: record.kind,
            name: record.name,
            key: record.key,
            edits: select(coreDataStore).getEntityRecordEdits(
              record.kind,
              record.name,
              record.key,
            ),
          })),
      ),
    [],
  );
  const last = useRef(changes);
  useEffect(() => {
    if (last.current !== changes) {
      last.current = changes;
      if (changes !== "[]") onDirty();
    }
  }, [changes, onDirty]);
  return null;
}

const GutenbergSession = forwardRef<
  GutenbergEditorHandle,
  GutenbergEditorProps
>(function GutenbergSession(props, ref) {
  const [blocks, setBlocks] = useState(() =>
    initialValue(props.initialBlocks, props.initialHTML),
  );
  const [addedMedia, setAddedMedia] = useState<Media[]>([]);
  const [error, setError] = useState("");
  const [patterns, setPatterns] = useState<
    { name: string; title: string; content: string; categories: string[]; inserter?: boolean; blockTypes?: string[] }[]
  >([]);
  const [themeDocument, setThemeDocument] = useState<ThemeJSON | null>(null);
  const [themeOverrides,setThemeOverrides]=useState<ThemeStyleOverrides>({});
  const entityHistory = useSelect(
    (select) => ({
      undo: select(coreDataStore).hasUndo(),
      redo: select(coreDataStore).hasRedo(),
      dirty:
        select(coreDataStore).__experimentalGetDirtyEntityRecords().length > 0,
    }),
    [],
  );
  const [historyVersion, setHistoryVersion] = useState(0);
  const [previewContext, setPreviewContext] = useState<Record<string, unknown>>(
    {},
  );
  const [reusable, setReusable] = useState<any[]>([]);
  const [patternsOpen, setPatternsOpen] = useState(false);
  const [editingPattern, setEditingPattern] = useState<any>(null);
  const patternEditorRef = useRef<GutenbergEditorHandle>(null);
  const [patternHTML, setPatternHTML] = useState("");
  const [patternTitle, setPatternTitle] = useState("");
  const [patternBusy, setPatternBusy] = useState(false);
  const reloadReusable = useCallback(async () => {
    try {
      const records = await apiFetch<any[]>({
        path: "/wp/v2/blocks?per_page=100&context=edit",
      });
      setReusable(records);
    } catch {
      /* Authors without entity-edit capabilities keep ordinary content editing. */
    }
  }, []);
  useEffect(() => {
    void reloadReusable();
  }, [reloadReusable]);
  useEffect(() => {
    let active = true;
    if (props.postId) {
      setPreviewContext({
        postId: props.postId,
        postType: props.postType || "post",
        // Post metadata stays a preview here; the surrounding document form
        // owns editable title/excerpt fields and their optimistic version.
        queryId: 0,
      });
      return;
    }
    if (props.context !== "site") return;
    apiFetch<any[]>({
      path: "/wp/v2/posts?per_page=1&status=publish&context=view&has_password=false",
    })
      .then((posts) => {
        if (active && posts[0])
          setPreviewContext({
            postId: posts[0].id,
            postType: posts[0].type,
            queryId: 0,
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [props.postId, props.postType, props.context]);
  const blocksRef = useRef(blocks);
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const history = useRef({ items: [blocks], index: 0, lastInput: 0 });
  const signature = useRef(JSON.stringify(toStored(blocks)));
  const allMedia = useMemo(
    () => [
      ...new Map(
        [...props.media, ...addedMedia].map((item) => [item.id, item]),
      ).values(),
    ],
    [props.media, addedMedia],
  );
  const reportError = useCallback(
    (message: string) => {
      setError(message);
      props.onError?.(message);
    },
    [props.onError],
  );

  const emit = useCallback(
    (next: Block[], kind: "input" | "change" | "history") => {
      setBlocks(next);
      blocksRef.current = next;
      const stored = toStored(next);
      const nextSignature = JSON.stringify(stored);
      if (signature.current === nextSignature) return;
      signature.current = nextSignature;
      if (kind !== "history") {
        const state = history.current;
        const now = Date.now();
        const mergeTyping =
          kind === "input" &&
          state.index === state.items.length - 1 &&
          state.index > 0 &&
          now - state.lastInput < 800;
        if (mergeTyping) state.items[state.index] = next;
        else {
          state.items = state.items.slice(0, state.index + 1);
          state.items.push(next);
          if (state.items.length > 100) state.items.shift();
          state.index = state.items.length - 1;
        }
        state.lastInput = kind === "input" ? now : 0;
      }
      setHistoryVersion((value) => value + 1);
      onChangeRef.current(stored, serialize(next));
    },
    [],
  );

  const travel = useCallback(
    (direction: -1 | 1) => {
      const active = containerRef.current?.querySelector<HTMLIFrameElement>(
        'iframe[name="editor-canvas"]',
      )?.contentDocument?.activeElement;
      const name = active?.closest("[data-type]")?.getAttribute("data-type");
      const entities = select(coreDataStore),
        canTravel = direction === -1 ? entities.hasUndo() : entities.hasRedo();
      const inEntity = [
        "core/site-title",
        "core/site-tagline",
        "core/site-logo",
        "core/navigation",
        "core/navigation-link",
        "core/navigation-submenu",
        "core/template-part",
      ].includes(name || "");
      if (inEntity && canTravel) {
        if (direction === -1) dispatch(coreDataStore).undo();
        else dispatch(coreDataStore).redo();
        return;
      }
      const state = history.current;
      const nextIndex = state.index + direction;
      if (nextIndex < 0 || nextIndex >= state.items.length) {
        if (
          canTravel &&
          entities.__experimentalGetDirtyEntityRecords().length
        ) {
          if (direction === -1) dispatch(coreDataStore).undo();
          else dispatch(coreDataStore).redo();
        }
        return;
      }
      state.index = nextIndex;
      state.lastInput = 0;
      emit(state.items[nextIndex], "history");
    },
    [emit],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let canvasDocument: Document | null = null;
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      travel(event.shiftKey || key === "y" ? 1 : -1);
    };
    const bind = () => {
      const document =
        container.querySelector<HTMLIFrameElement>(
          'iframe[name="editor-canvas"]',
        )?.contentDocument || null;
      if (document === canvasDocument) return;
      canvasDocument?.removeEventListener("keydown", keyDown, true);
      canvasDocument = document;
      canvasDocument?.addEventListener("keydown", keyDown, true);
    };
    const observer = new MutationObserver(bind);
    observer.observe(container, { childList: true, subtree: true });
    container.addEventListener("load", bind, true);
    bind();
    return () => {
      observer.disconnect();
      container.removeEventListener("load", bind, true);
      canvasDocument?.removeEventListener("keydown", keyDown, true);
    };
  }, [travel]);

  useImperativeHandle(
    ref,
    () => ({
      undo: () => travel(-1),
      redo: () => travel(1),
      getBlocks: () => toStored(blocksRef.current),
      getHTML: () => serialize(blocksRef.current),
      insertBlocks: (next) =>
        emit([...blocksRef.current, ...restoreBlocks(next)], "change"),
      flushEntities: async () => {
        const records =
          select(coreDataStore).__experimentalGetDirtyEntityRecords();
        for (const record of records) {
          if (
            (record.kind === "root" && record.name === "site") ||
            (record.kind === "postType" &&
              ["wp_block", "wp_navigation", "wp_template_part"].includes(
                record.name,
              ))
          ) {
            try {
              await dispatch(coreDataStore).saveEditedEntityRecord(
                record.kind,
                record.name,
                record.key,
                { throwOnError: true },
              );
            } catch (reason) {
              throw reason instanceof Error
                ? reason
                : new Error(
                    reason && typeof reason === "object" && "message" in reason
                      ? String(reason.message)
                      : "This change could not be saved. Please try again.",
                  );
            }
          }
        }
      },
    }),
    [travel, emit],
  );

  useEffect(() => {
    let active = true;
    api<{
      settings: { timezone: string; dateFormat: string; timeFormat: string; weekStartsOn?: 0|1|2|3|4|5|6 };
    }>("/public/site")
      .then(({ settings }) => {
        if (!active) return;
        const current = getDateSettings();
        const fixed = /^([+-])(\d{2}):(\d{2})$/.exec(settings.timezone);
        const offset = fixed
          ? (fixed[1] === "-" ? -1 : 1) *
            (Number(fixed[2]) + Number(fixed[3]) / 60)
          : current.timezone.offset;
        setDateSettings({
          ...current,
          l10n: {...current.l10n,startOfWeek:settings.weekStartsOn ?? 1},
          timezone: {
            ...current.timezone,
            string: fixed ? "" : settings.timezone,
            offset,
            offsetFormatted: String(offset),
          },
          formats: {
            ...current.formats,
            date: settings.dateFormat,
            time: settings.timeFormat,
          },
        });
      })
      .catch(() => {});
    api<{
      patterns: {
        id: number;
        title: string;
        content: string;
        blocks: SerializedBlock[] | null;
        rawContent?: string;
        theme?: string;
        slug?: string;
        sourceMetadata?: { categories?: string[]; inserter?: boolean; blockTypes?: string[] };
      }[];
      theme?: { themeJSON: ThemeJSON | null; fonts?: ThemeJSON[] };
      styles?:ThemeStyleOverrides;
    }>("/public/design")
      .then((design) => {
        if (active) {
          setThemeDocument(design.theme?.themeJSON || {settings:{typography:{fontFamilies:design.theme?.fonts || []}}});
          setThemeOverrides(design.styles || {});
          setPatterns(
            design.patterns.map((pattern) => ({
              name: pattern.theme && pattern.slug ? `${pattern.theme}/${pattern.slug}` : `worldact/pattern-${pattern.id}`,
              title: pattern.title,
              content: pattern.rawContent || serialize(initialValue(pattern.blocks, pattern.content)),
              categories: pattern.sourceMetadata?.categories?.length ? pattern.sourceMetadata.categories : ["featured"],
              inserter: pattern.sourceMetadata?.inserter !== false,
              blockTypes: pattern.sourceMetadata?.blockTypes || [],
            })),
          );
        }
      })
      .catch(() => {
        /* Patterns are optional; content editing remains available. */
      });
    return () => {
      active = false;
    };
  }, []);

  const upload = useCallback(
    async (files: File[]) => {
      const uploaded = props.onUpload
        ? await props.onUpload(files)
        : await Promise.all(
            files.map(async (file) => {
              const data = new FormData();
              data.append("file", file);
              return (
                await api<{ media: Media }>("/media", {
                  method: "POST",
                  body: data,
                })
              ).media;
            }),
          );
      setAddedMedia((current) => [...current, ...uploaded]);
      return uploaded;
    },
    [props.onUpload],
  );

  useEffect(() => {
    dispatch(coreDataStore).receiveEntityRecords(
      "postType",
      "attachment",
      allMedia.map((item) => attachment(item, true)),
      undefined,
      false,
    );
  }, [allMedia]);

  const mediaUpload = useCallback(
    async ({
      filesList,
      allowedTypes,
      multiple,
      onFileChange,
      onSuccess,
      onError,
    }: MediaUploadOptions) => {
      const files = Array.from(filesList);
      if (multiple === false && files.length > 1) {
        onError?.("Choose a single file for this block.");
        return;
      }
      if (
        allowedTypes?.length &&
        files.some(
          (file) =>
            !allowedTypes.some(
              (type) =>
                file.type === type ||
                file.type.startsWith(`${type.replace(/\/\*$/, "")}/`),
            ),
        )
      ) {
        onError?.("This file type cannot be used in this block.");
        return;
      }
      try {
        const uploaded = (await upload(files)).map((item) => attachment(item));
        onFileChange?.(uploaded);
        onSuccess?.(uploaded);
      } catch (reason) {
        const message =
          reason instanceof Error
            ? reason.message
            : "The upload could not be completed.";
        onError?.(message);
        reportError(message);
      }
    },
    [upload, reportError],
  );

  const settings = useMemo(
    () => ({
      allowedBlockTypes:
        props.context === "site"
          ? [
              ...WORLDAct_CONTENT_BLOCKS,
              ...WORLDAct_DYNAMIC_BLOCKS,
              ...WORLDAct_SITE_BLOCKS,
              ...siteBindings.map((binding) => `worldact/${binding.name}`),
            ]
          : [...WORLDAct_CONTENT_BLOCKS, ...WORLDAct_DYNAMIC_BLOCKS],
      alignWide: true,
      supportsLayout: true,
      hasFixedToolbar: true,
      canLockBlocks: true,
      imageEditing: false,
      imageSizes: [
        { slug: "thumbnail", name: "Thumbnail" },
        { slug: "medium", name: "Medium" },
        { slug: "large", name: "Large" },
        { slug: "full", name: "Full size" },
      ],
      maxWidth: Number.parseFloat(themeDocument?.settings?.layout?.wideSize) || 1120,
      colors: themeDocument?.settings?.color?.palette || colors,
      fontSizes: themeDocument?.settings?.typography?.fontSizes || [
        { name: "Small", slug: "small", size: 14 },
        { name: "Medium", slug: "medium", size: 20 },
        { name: "Large", slug: "large", size: 36 },
        { name: "Extra Large", slug: "x-large", size: 48 },
      ],
      __experimentalFeatures: {
        ...themeDocument?.settings,
        appearanceTools: true,
        color: {
          custom: true,
          customGradient: true,
          text: true,
          background: true,
          ...themeDocument?.settings?.color,
          palette: { theme: themeDocument?.settings?.color?.palette || colors },
          gradients: { theme: themeDocument?.settings?.color?.gradients || [] },
          duotone: { theme: themeDocument?.settings?.color?.duotone || [] },
        },
        typography: {
          customFontSize: true,
          lineHeight: true,
          fontStyle: true,
          fontWeight: true,
          letterSpacing: true,
          textDecoration: true,
          textTransform: true,
          ...themeDocument?.settings?.typography,
          fontFamilies: { theme: themeDocument?.settings?.typography?.fontFamilies || [] },
          fontSizes: { theme: themeDocument?.settings?.typography?.fontSizes || [] },
        },
        spacing: {
          padding: true,
          margin: true,
          blockGap: true,
          units: ["px", "em", "rem", "%", "vw", "vh"],
          ...themeDocument?.settings?.spacing,
          spacingSizes: { theme: themeDocument?.settings?.spacing?.spacingSizes || [] },
        },
        border: { color: true, radius: true, style: true, width: true },
        layout: themeDocument?.settings?.layout || { contentSize: "680px", wideSize: "1120px" },
      },
      __experimentalBlockPatterns: patterns,
      __experimentalBlockPatternCategories: [...new Set(patterns.flatMap((pattern) => pattern.categories))].map((name) => ({ name, label: name.replace(/[-_]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) })),
      __experimentalReusableBlocks: reusable,
      __experimentalBlockBindingsSupportedAttributes: {
        "core/post-date": ["datetime"],
        "core/navigation-link": ["url"],
        "core/navigation-submenu": ["url"],
      },
      onNavigateToEntityRecord: ({
        postId,
        postType,
      }: {
        postId: string | number;
        postType: string;
      }) => {
        if (!["wp_block", "wp_template_part"].includes(postType)) return;
        const base =
          postType === "wp_template_part" ? "template-parts" : "blocks";
        apiFetch<any>({
          path: `/wp/v2/${base}/${encodeURIComponent(postId)}?context=edit`,
        })
          .then((record) => {
            setEditingPattern({ ...record, _entityType: postType });
            setPatternHTML(record.content.raw);
            setPatternTitle(record.title.raw);
            setPatternsOpen(true);
          })
          .catch((reason) =>
            reportError(reason.message || "This pattern could not be opened."),
          );
      },
      __experimentalFetchLinkSuggestions: async (search: string) => {
        const { posts } = await api<{
          posts: { id: number; title: string; slug: string; type: string }[];
        }>(`/posts?search=${encodeURIComponent(search)}`);
        return posts.map((post) => ({
          id: post.id,
          title: post.title || "(no title)",
          url: `${window.location.origin}/${post.type === "page" ? "pages" : "posts"}/${post.slug}`,
          type: post.type,
          kind: "post-type",
        }));
      },
      mediaUpload,
      styles: canvasStyles,
    }),
    [mediaUpload, patterns, reusable, props.context, reportError, themeDocument],
  );

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (
      !(event.metaKey || event.ctrlKey) ||
      event.altKey ||
      !target.isContentEditable
    )
      return;
    if (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y") {
      event.preventDefault();
      event.stopPropagation();
      travel(event.shiftKey || event.key.toLowerCase() === "y" ? 1 : -1);
    }
  };
  // Reading this value keeps the toolbar in step with the ref-backed history.
  void historyVersion;
  return (
    <MediaContext.Provider
      value={{ media: allMedia, upload, onError: reportError }}
    >
      <SlotFillProvider>
        <BlockEditorProvider
          value={blocks}
          onInput={(next) => emit(next, "input")}
          onChange={(next) => emit(next, "change")}
          settings={settings}
        >
          <EntityEditsObserver
            onDirty={() =>
              onChangeRef.current(
                toStored(blocksRef.current),
                serialize(blocksRef.current),
              )
            }
          />
          <BlockContextProvider value={previewContext}>
            <div
              ref={containerRef}
              className={`worldact-gutenberg ${props.inspectorOpen ? "has-block-inspector" : ""}`}
              onKeyDownCapture={keyDown}
            >
              {error && (
                <Notice
                  status="error"
                  isDismissible
                  onRemove={() => setError("")}
                >
                  {error}
                </Notice>
              )}
              <div
                className="worldact-gutenberg-toolbar"
                aria-label="Block editing tools"
              >
                <Inserter
                  position="bottom right"
                  toggleProps={{ label: "Insert a block" }}
                />
                <Button
                  label="Undo"
                  icon={<UndoIcon />}
                  disabled={
                    history.current.index < 1 &&
                    !(entityHistory.dirty && entityHistory.undo)
                  }
                  onClick={() => travel(-1)}
                />
                <Button
                  label="Redo"
                  icon={<UndoIcon redo />}
                  disabled={
                    history.current.index >= history.current.items.length - 1 &&
                    !(entityHistory.dirty && entityHistory.redo)
                  }
                  onClick={() => travel(1)}
                />
                {!props.hidePatternManager && (
                  <Button
                    onClick={() => {
                      setPatternsOpen(true);
                      void reloadReusable();
                    }}
                  >
                    Patterns
                  </Button>
                )}
                <span className="worldact-toolbar-divider" />
                <div className="worldact-selected-block-toolbar">
                  <BlockToolbar hideDragHandle />
                </div>
              </div>
              <div className="worldact-gutenberg-workspace">
                {(props.inserterOpen || props.listViewOpen) && (
                  <aside
                    className="worldact-gutenberg-outline"
                    aria-label={
                      props.listViewOpen ? "List view" : "Block inserter"
                    }
                  >
                    {props.listViewOpen ? (
                      <>
                        <h2>List View</h2>
                        <ListView showBlockMovers isExpanded />
                      </>
                    ) : (
                      <InserterLibrary
                        showInserterHelpPanel={false}
                        shouldFocusBlock
                      />
                    )}
                  </aside>
                )}
                <div className="worldact-gutenberg-canvas">
                  <BlockCanvas
                    height="min(72vh, 900px)"
                    styles={
                      props.canvasCSS
                        ? [...canvasStyles, ...(themeDocument ? [{css:compileThemeStyles(themeDocument, "body.editor-styles-wrapper",themeOverrides)}] : []), { css: props.canvasCSS }]
                        : [...canvasStyles, ...(themeDocument ? [{css:compileThemeStyles(themeDocument, "body.editor-styles-wrapper",themeOverrides)}] : [])]
                    }
                  />
                </div>
                {props.inspectorOpen && (
                  <aside
                    className="worldact-gutenberg-inspector"
                    aria-label="Block settings"
                  >
                    <BlockInspector />
                  </aside>
                )}
              </div>
              <div className="worldact-gutenberg-breadcrumb">
                <BlockBreadcrumb />
              </div>
            </div>
          </BlockContextProvider>
          {patternsOpen && (
            <Modal
              title={
                editingPattern
                  ? editingPattern._entityType === "wp_template_part"
                    ? "Edit template part"
                    : "Edit synced pattern"
                  : "Synced patterns"
              }
              onRequestClose={() => {
                setPatternsOpen(false);
                setEditingPattern(null);
              }}
              size="large"
              className="worldact-synced-patterns"
            >
              {error && (
                <Notice
                  status="error"
                  isDismissible
                  onRemove={() => setError("")}
                >
                  {error}
                </Notice>
              )}
              {editingPattern ? (
                <>
                  <label>
                    {editingPattern._entityType === "wp_template_part"
                      ? "Template part name"
                      : "Pattern name"}
                    <input
                      value={patternTitle}
                      onChange={(event) => setPatternTitle(event.target.value)}
                      maxLength={200}
                    />
                  </label>
                  <GutenbergEditor
                    ref={patternEditorRef}
                    initialBlocks={null}
                    initialHTML={editingPattern.content.raw}
                    resetKey={`pattern-${editingPattern.id}-${editingPattern.version}`}
                    media={allMedia}
                    onChange={(_next, html) => setPatternHTML(html)}
                    hidePatternManager
                    canvasCSS={props.canvasCSS}
                    context={props.context}
                    onError={reportError}
                  />
                  <Button
                    variant="primary"
                    disabled={patternBusy || !patternTitle.trim()}
                    onClick={async () => {
                      setPatternBusy(true);
                      try {
                        await patternEditorRef.current?.flushEntities();
                        const record = await apiFetch<any>({
                          path: `/wp/v2/${editingPattern._entityType === "wp_template_part" ? "template-parts" : "blocks"}/${encodeURIComponent(editingPattern.id)}`,
                          method: "POST",
                          data: {
                            title: patternTitle,
                            content: patternHTML,
                            version: editingPattern.version,
                          },
                        });
                        dispatch(coreDataStore).receiveEntityRecords(
                          "postType",
                          editingPattern._entityType || "wp_block",
                          record,
                          undefined,
                          false,
                        );
                        setEditingPattern(null);
                        await reloadReusable();
                      } catch (reason) {
                        reportError((reason as Error).message);
                      } finally {
                        setPatternBusy(false);
                      }
                    }}
                  >
                    {editingPattern._entityType === "wp_template_part"
                      ? "Save template part"
                      : "Save pattern"}
                  </Button>
                  <Button onClick={() => setEditingPattern(null)}>
                    Back to patterns
                  </Button>
                </>
              ) : (
                <>
                  <p>
                    Synced patterns update everywhere they are used. Create one
                    from the current document or insert an existing pattern.
                  </p>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      const title = window.prompt("Pattern name");
                      if (!title?.trim()) return;
                      setPatternBusy(true);
                      try {
                        const record = await apiFetch<any>({
                          path: "/wp/v2/blocks",
                          method: "POST",
                          data: {
                            title: title.trim(),
                            content: serialize(blocksRef.current),
                            status: "publish",
                          },
                        });
                        dispatch(coreDataStore).receiveEntityRecords(
                          "postType",
                          "wp_block",
                          record,
                          undefined,
                          false,
                        );
                        await reloadReusable();
                      } catch (reason) {
                        reportError((reason as Error).message);
                      } finally {
                        setPatternBusy(false);
                      }
                    }}
                    disabled={patternBusy}
                  >
                    Create from this document
                  </Button>
                  <ul className="worldact-pattern-entities">
                    {reusable.map((record) => (
                      <li key={record.id}>
                        <strong>
                          {record.title.raw || record.title.rendered}
                        </strong>
                        <span>
                          <Button
                            onClick={() => {
                              emit(
                                [
                                  ...blocksRef.current,
                                  createBlock("core/block", { ref: record.id }),
                                ],
                                "change",
                              );
                              setPatternsOpen(false);
                            }}
                          >
                            Insert
                          </Button>
                          <Button
                            onClick={() => {
                              setEditingPattern(record);
                              setPatternTitle(record.title.raw);
                              setPatternHTML(record.content.raw);
                            }}
                          >
                            Edit
                          </Button>
                          <Button
                            isDestructive
                            onClick={async () => {
                              if (
                                !window.confirm(
                                  "Delete this synced pattern? References to it will no longer display content.",
                                )
                              )
                                return;
                              try {
                                await dispatch(
                                  coreDataStore,
                                ).deleteEntityRecord(
                                  "postType",
                                  "wp_block",
                                  record.id,
                                  { force: true },
                                );
                                await reloadReusable();
                              } catch (reason) {
                                reportError((reason as Error).message);
                              }
                            }}
                          >
                            Delete
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!reusable.length && <p>No synced patterns yet.</p>}
                </>
              )}
            </Modal>
          )}
          <Popover.Slot />
        </BlockEditorProvider>
      </SlotFillProvider>
    </MediaContext.Provider>
  );
});

export const GutenbergEditor = forwardRef<
  GutenbergEditorHandle,
  GutenbergEditorProps
>(function GutenbergEditor(props, ref) {
  return <GutenbergSession key={props.resetKey} {...props} ref={ref} />;
});

export default GutenbergEditor;
