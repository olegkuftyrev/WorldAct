// Matches the supplied WordPress get_post_format_strings() order.
export const postFormats = [
  "standard", "aside", "chat", "gallery", "link", "image", "quote", "status", "video", "audio",
] as const;
export type PostFormat = (typeof postFormats)[number];
