// Pure block classification shared by storage selection and public rendering.
export const THEME_BLOCKS = [
  "core/term-description", "core/social-links", "core/social-link", "core/avatar", "core/post-navigation-link", "core/search",
  "core/comments", "core/comments-title", "core/comment-template", "core/comment-date", "core/comment-author-name", "core/comment-content",
  "core/comment-edit-link", "core/comment-reply-link", "core/comments-pagination", "core/comments-pagination-previous",
  "core/comments-pagination-numbers", "core/comments-pagination-next", "core/post-comments-form", "core/categories", "core/loginout",
];

export const WIDGET_BLOCKS = [
  "core/latest-posts", "core/latest-comments", "core/archives", "core/calendar", "core/tag-cloud",
  "core/post-comments-count", "core/post-comments-link", "core/post-time-to-read", "core/query-total",
];

export const TERM_BLOCKS = ["core/terms-query", "core/term-template", "core/term-name", "core/term-count", "core/breadcrumbs", "core/page-list-item"];

export const INTERACTIVE_BLOCKS = [
  "core/accordion", "core/accordion-item", "core/accordion-heading", "core/accordion-panel",
  "core/tabs", "core/tab-list", "core/tab-panels", "core/tab-panel",
];

export const NAVIGATION_OVERLAY_BLOCKS = ["core/navigation-overlay-close"];

export const CORE_DYNAMIC_BLOCKS = [
  "core/icon",
  ...THEME_BLOCKS,
  ...WIDGET_BLOCKS,
  "core/footnotes",
  ...TERM_BLOCKS,
  ...INTERACTIVE_BLOCKS,
  ...NAVIGATION_OVERLAY_BLOCKS,
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
  "core/site-title",
  "core/site-tagline",
  "core/site-logo",
  "core/navigation",
  "core/navigation-link",
  "core/navigation-submenu",
  "core/page-list",
  "core/home-link",
  "core/template-part",
  "core/block",
  "core/pattern",
];
export const SUPPORTED_DYNAMIC_BLOCKS = new Set(CORE_DYNAMIC_BLOCKS);

type DynamicBlockNode = { name: string; innerBlocks?: readonly DynamicBlockNode[] };
export function hasDynamicBlocks(blocks: readonly DynamicBlockNode[] | null | undefined): boolean {
  return !!blocks?.some(block => SUPPORTED_DYNAMIC_BLOCKS.has(block.name) || block.name.startsWith("worldact/") || hasDynamicBlocks(block.innerBlocks));
}
