import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { z } from "zod";
import { rootDir } from "./db.js";
import { HttpError, plainText } from "./utils.js";

const finite = z.number().finite().nonnegative();
const tag = z.string().max(1000);
export const audioMetadataSchema = z.object({
  title: tag.optional(), artist: tag.optional(), album: tag.optional(), genre: tag.optional(), year: z.number().int().min(1).max(9999).optional(),
  length: finite.int().max(315360000).optional(), length_formatted: z.string().regex(/^(?:\d{1,5}:)?\d{1,3}:\d{2}$/).optional(),
  bitrate: finite.max(1e10).optional(), sample_rate: finite.max(1e7).optional(), channels: finite.int().max(1024).optional(), bits_per_sample: finite.int().max(1024).optional(),
  codec: z.string().max(200).optional(), fileformat: z.string().max(100).optional(), lossless: z.boolean().optional(),
  filesize: finite.int().max(32 * 1024 * 1024).optional(), mime_type: z.string().max(100).optional(),
}).strict();
export type AudioMetadata = z.infer<typeof audioMetadataSchema>;
export const MAX_AUDIO_ARTWORK_BYTES = 2 * 1024 * 1024;
const inspectionSchema = z.object({ metadata: audioMetadataSchema, artwork: z.object({ data: z.instanceof(Uint8Array).refine(value => value.byteLength > 0 && value.byteLength <= MAX_AUDIO_ARTWORK_BYTES), mimeType: z.string().max(100) }).strict().optional() }).strict();
export type AudioInspection = { metadata: AudioMetadata; artwork?: { data: Buffer; mimeType: string } };

// Parser input is an already-sniffed, size-bounded local buffer. There is no
// filename/URL input or network lookup. Untrusted tags never run as code.
const workerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  try {
    const {parseBuffer} = await import(workerData.parserURL);
    const parsed = await parseBuffer(new Uint8Array(workerData.bytes), {mimeType:workerData.mime, size:workerData.bytes.length}, {
      duration:true, skipCovers:!workerData.artwork, includeChapters:false, maxMemoryAllocation:4*1024*1024, maxMetadataEntries:1000, maxChapterCount:1
    });
    const common=parsed.common || {}, format=parsed.format || {}, result={};
    const text=(value,max)=>typeof value==='string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,max) : '';
    for(const key of ['title','artist','album']) { const value=text(common[key],1000); if(value)result[key]=value; }
    const genre=text(Array.isArray(common.genre)?common.genre.slice(0,10).join(', '):common.genre,1000); if(genre)result.genre=genre;
    if(Number.isInteger(common.year)&&common.year>0&&common.year<=9999)result.year=common.year;
    const duration=format.duration;
    if(Number.isFinite(duration)&&duration>=0&&duration<=315360000) {
      result.length=Math.round(duration);
      const seconds=Math.round(duration),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds/60)%60;
      result.length_formatted=(hours ? hours+':'+String(minutes).padStart(2,'0') : String(minutes))+':'+String(seconds%60).padStart(2,'0');
    }
    for(const [source,target,max] of [['bitrate','bitrate',1e10],['sampleRate','sample_rate',1e7],['numberOfChannels','channels',1024],['bitsPerSample','bits_per_sample',1024]])
      if(Number.isFinite(format[source])&&format[source]>=0&&format[source]<=max)result[target]=format[source];
    if(typeof format.lossless==='boolean')result.lossless=format.lossless;
    const codec=text(format.codec,200),container=text(format.container,100); if(codec)result.codec=codec;if(container)result.fileformat=container;
    if(Object.keys(result).length){result.filesize=workerData.bytes.length;result.mime_type=workerData.mime;}
    if(workerData.artwork){
      const image=Array.isArray(common.picture)?common.picture[0]:null;
      const artwork=image?.data instanceof Uint8Array && image.data.byteLength>0 && image.data.byteLength<=2*1024*1024 ? {data:image.data,mimeType:text(image.format,100)} : undefined;
      parentPort.postMessage({metadata:result,...(artwork?{artwork}:{})});
    } else parentPort.postMessage(result);
  } catch { parentPort.postMessage(workerData.artwork?{metadata:{}}:{}); }
})();
`;
let activeParsers = 0;
async function inspectAudioBuffer(buffer: Buffer, mime: string, artwork: boolean): Promise<AudioInspection> {
  if (!mime.startsWith("audio/")) return { metadata: {} };
  if (!buffer.length || buffer.length > 32 * 1024 * 1024) throw new HttpError(400, "Audio metadata requires a file from 1 byte to 32 MiB.");
  if (activeParsers >= 2) throw new HttpError(503, "Two audio files are being checked. Try uploading again shortly.");
  activeParsers++;
  let worker: Worker | undefined;
  try {
    const parserURL = pathToFileURL(createRequire(path.join(rootDir, "package.json")).resolve("music-metadata")).href;
    const inspection = await new Promise<AudioInspection>(resolve => {
      let settled = false;
      worker = new Worker(workerSource, { eval: true, name: "WorldAct audio metadata", workerData: { parserURL, bytes: buffer, mime, artwork }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      const owned = worker;
      const finish = (value: unknown = {}) => {
        if (settled) return; settled = true; clearTimeout(timer);
        const parsed = inspectionSchema.safeParse(artwork ? value : { metadata: value });
        const result: AudioInspection = parsed.success ? { metadata: parsed.data.metadata, ...(parsed.data.artwork ? { artwork: { data: Buffer.from(parsed.data.artwork.data), mimeType: parsed.data.artwork.mimeType } } : {}) } : { metadata: {} };
        // A completed parse is still a live worker until physical exit. Await
        // termination before returning, and release its slot only on exit.
        void Promise.resolve().then(() => owned.terminate()).then(() => resolve(result), () => resolve({ metadata: {} }));
      };
      const timer = setTimeout(finish, 5000);
      owned.once("message", finish); owned.once("error", () => finish()); owned.once("exit", () => { activeParsers--; finish(); });
    });
    // HTML is stripped once at the trust boundary, including script contents.
    for (const field of ["title", "artist", "album", "genre", "codec", "fileformat"] as const) if (inspection.metadata[field]) inspection.metadata[field] = plainText(inspection.metadata[field]!).trim();
    return inspection;
  } finally { if (!worker) activeParsers--; }
}
export async function inspectAudio(buffer: Buffer, mime: string): Promise<AudioMetadata> {
  return (await inspectAudioBuffer(buffer, mime, false)).metadata;
}
/** Cover bytes remain separate from metadata and require image verification before storage. */
export const inspectAudioWithArtwork = (buffer: Buffer, mime: string) => inspectAudioBuffer(buffer, mime, true);
