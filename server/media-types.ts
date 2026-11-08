import { fileTypeFromBuffer } from "file-type";

/** Canonical MIME names come only from the local file signature, never a request hint. */
export async function detectMediaType(bytes: Uint8Array) {
  const type = await fileTypeFromBuffer(bytes);
  // file-type reports Apple's audio-only M4A brand with this legacy MIME alias.
  // Keep the verified extension and do not broaden generic MP4/video containers.
  return type?.ext === "m4a" && type.mime === "audio/x-m4a"
    ? { ...type, mime: "audio/mp4" as const }
    : type;
}
