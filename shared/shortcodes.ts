export const SHORTCODE_NAMES = new Set(["gallery", "audio", "video", "playlist", "caption", "wp_caption", "embed"]);
export function hasShortcodes(input: string) { return /\[\[?(?:gallery|audio|video|playlist|caption|wp_caption|embed)(?=[\s/\]])/.test(input); }
