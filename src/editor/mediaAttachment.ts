import type { Media } from "../api";
export function attachment(
  item: Media,
  rest = false,
  origin = typeof window !== "undefined"
    ? window.location.origin
    : "http://localhost",
): Record<string, unknown> {
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
    ...(item.image
      ? { image: { ...item.image, src: new URL(item.image.src, origin).href } }
      : {}),
    artist: item.audioMetadata?.artist,
    album: item.audioMetadata?.album,
    fileLength: item.audioMetadata?.length_formatted,
    meta: item.audioMetadata || {},
    media_details: {
      width: dimensions.width || undefined,
      height: dimensions.height || undefined,
      sizes,
      ...item.audioMetadata,
    },
    link: item.url,
  };
}
