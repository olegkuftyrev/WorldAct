import { parseShortcodes, hasShortcodes, ShortcodeLimitError } from "./shortcode-parser.js";
import { HttpError } from "./utils.js";
type Options = { media?: ReadonlyMap<number, number>; posts?: ReadonlyMap<number, number>; urls?: ReadonlyMap<string, string>; detachMissingShortcodeMediaURLs?: boolean };
const quote = (value: string) => '"' + value.replace(/"/g, "&quot;") + '"';
/** Rewrite only supported source references; missing lists remain explicit. */
export function remapShortcodeReferences(input: string, options: Options, warn: (message: string) => void, depth = 0): string {
  if (!hasShortcodes(input) || depth > 12) return input;
  let parsed;
  try { parsed = parseShortcodes(input); } catch (error) { if (error instanceof ShortcodeLimitError) throw new HttpError(400, error.message); throw error; }
  const urls = [...(options.urls || [])].filter(([source, target]) => source && target).sort((a,b) => b[0].length - a[0].length);
  return parsed.map(piece => {
    if (typeof piece === "string" || piece.escaped) return typeof piece === "string" ? piece : piece.raw;
    const a = { ...piece.attributes }; let changed = false;
    const uploadedURL = (value: string, field: string) => {
      const source = value.replace(/&amp;/g, "&");
      const mapping = urls.find(([from, to]) => source === from || source.startsWith(from) && /^[?#]/.test(source.slice(from.length)) || source === to || source.startsWith(to) && /^[?#]/.test(source.slice(to.length)));
      if (mapping) { changed = true; return source === mapping[0] || source.startsWith(mapping[0]) && /^[?#]/.test(source.slice(mapping[0].length)) ? mapping[1] + source.slice(mapping[0].length) : source; }
      if (options.detachMissingShortcodeMediaURLs && /^(?:https?:\/\/[^/]+)?\/uploads\//i.test(source)) { changed = true; warn(`Detached unavailable uploaded URL from [${piece.tag} ${field}].`); return ""; }
      return value;
    };
    if (options.media && ["gallery", "playlist"].includes(piece.tag)) {
      for (const field of ["ids", "include", "exclude"]) if (Object.hasOwn(a, field)) {
        const source = [...new Set(a[field].split(/[\s,]+/).filter(value => /^[1-9]\d{0,9}$/.test(value)).map(Number))];
        const target = source.map(id => options.media!.get(id)).filter((id): id is number => id !== undefined);
        if (target.length !== source.length) warn(`Detached missing media IDs from [${piece.tag} ${field}].`);
        a[field] = target.join(",") || "0"; changed = true;
      }
    }
    if (options.posts && ["gallery", "playlist"].includes(piece.tag) && Object.hasOwn(a, "id")) {
      const source = Number(a.id), target = options.posts.get(source);
      a.id = String(target || 0); changed = true;
      if (!target && source) warn(`Detached missing parent post ${source} from [${piece.tag}].`);
    }
    if (options.media && ["caption", "wp_caption"].includes(piece.tag)) for (const field of ["id", "caption_id"]) {
      const attachment = /^(attachment[_-])(\d+)$/.exec(a[field] || "");
      if (attachment) { const target = options.media.get(Number(attachment[2])); a[field] = target ? attachment[1] + target : "attachment-missing"; changed = true; if (!target) warn(`Detached missing caption attachment ${attachment[2]}.`); }
    }
    if (options.urls && ["audio", "video", "embed"].includes(piece.tag)) for (const field of ["src", "poster", "mp3", "m4a", "wav", "ogg", "wma", "flac", "mp4", "m4v", "webm", "ogv", "wmv", "flv"]) if (Object.hasOwn(a, field)) {
      a[field] = uploadedURL(a[field], field);
    }
    const content = piece.content === null ? null : piece.tag === "embed" && options.urls ? uploadedURL(piece.content.trim(), "content") : remapShortcodeReferences(piece.content, options, warn, depth + 1);
    if (!changed && content === piece.content) return piece.raw;
    const opening = "[" + piece.tag + Object.entries(a).map(([key, value]) => " " + (/^\d+$/.test(key) ? "" : key + "=") + quote(value)).join("");
    return (content === null ? opening + (/\/\s*\]$/.test(piece.raw) ? " /]" : "]") : opening + "]" + content + "[/" + piece.tag + "]") + piece.suffix;
  }).join("");
}
