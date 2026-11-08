import { createHash, randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { fileTypeFromBuffer } from "file-type";
import type { PoolClient } from "pg";
import type { AudioInspection } from "./audio-metadata.js";
import { buildSizes } from "./media-files.js";
import { uploadsDir } from "./db.js";

/** Store only decoded local image bytes; linked APIC artwork is never fetched. */
export async function storeAudioArtwork(artwork: AudioInspection["artwork"], client: PoolClient, authorId: number, title: string, prefix: string, settings: Record<string, any>): Promise<{ id: number | null; files: string[] }> {
  const empty = { id: null, files: [] };
  if (!artwork) return empty;
  const type = await fileTypeFromBuffer(artwork.data).catch(() => undefined);
  if (!type || !["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"].includes(type.mime)) return empty;
  const metadata = await sharp(artwork.data, { limitInputPixels: 20_000_000 }).metadata().catch(() => null);
  if (!metadata?.width || !metadata.height || metadata.width * metadata.height > 20_000_000) return empty;
  const hash = createHash("sha256").update(artwork.data).digest("hex");
  // Deduplication stays within the uploader's Media Library ownership boundary.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`worldact-audio-artwork:${authorId}:${hash}`]);
  const existing = (await client.query("SELECT id FROM media WHERE author_id=$1 AND cover_hash=$2 AND mime_type LIKE 'image/%' ORDER BY id LIMIT 1", [authorId, hash])).rows[0];
  if (existing) return { id: existing.id, files: [] };
  // Creating normal image sizes also verifies that the payload decodes fully.
  const sizes = await buildSizes(artwork.data, prefix, settings).catch(() => null);
  if (!sizes) return empty;
  const filename = `${prefix}${randomBytes(20).toString("hex")}.${type.ext}`, files = Object.values(sizes).map(size => size.filename);
  try {
    await writeFile(path.join(uploadsDir, filename), artwork.data, { flag: "wx" });
    files.push(filename);
    const row = (await client.query("INSERT INTO media(author_id,title,filename,mime_type,size,width,height,sizes,cover_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9) RETURNING id", [authorId, (title + " artwork").slice(0, 300), filename, type.mime, artwork.data.length, metadata.width, metadata.height, JSON.stringify(sizes), hash])).rows[0];
    return { id: row.id, files };
  } catch (error) {
    await Promise.all(files.map(file => unlink(path.join(uploadsDir, file)).catch(() => {}))); throw error;
  }
}
