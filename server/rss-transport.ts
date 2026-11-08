import http, { type IncomingMessage, type RequestOptions, type ClientRequest } from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from "node:zlib";

export const MAX_FEED_WIRE_BYTES = 1024 * 1024;
export const MAX_FEED_XML_BYTES = 2 * 1024 * 1024;
export class FeedError extends Error {}
export type FeedAddress = { address: string; family: number };
type Request = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type FeedTransportOptions = { resolve?: (host: string) => Promise<FeedAddress[]>; request?: Request; timeoutMs?: number; dnsTimeoutMs?: number };

export function normalizeFeedURL(input: unknown): URL {
  if (typeof input !== "string" || !input || input.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(input) || !/^https?:\/\//i.test(input)) throw new FeedError("Use an absolute HTTP or HTTPS feed URL.");
  let url: URL;
  try { url = new URL(input); } catch { throw new FeedError("The feed URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname.includes("%")) throw new FeedError("The feed URL is invalid.");
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    url.hostname = url.hostname.replace(/\.$/, "");
    if (url.hostname.includes("..")) throw new FeedError("The feed URL is invalid.");
  }
  url.hash = "";
  return url;
}
function publicIPv4(address: string) {
  const octets = address.split(".").map(Number), [a, b, c] = octets;
  return octets.length === 4 && octets.every(value => Number.isInteger(value) && value >= 0 && value <= 255) &&
    !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
function ipv6Words(address: string): number[] | null {
  if (isIP(address) !== 6 || address.includes("%")) return null;
  let source = address.toLowerCase();
  if (source.includes(".")) source = source.replace(/(\d+\.\d+\.\d+\.\d+)$/, value => { const [a, b, c, d] = value.split(".").map(Number); return ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16); });
  const [left, right] = source.split("::"), before = left ? left.split(":") : [], after = right ? right.split(":") : [];
  return [...before, ...Array(source.includes("::") ? 8 - before.length - after.length : 0).fill("0"), ...after].map(part => parseInt(part, 16));
}
/** Public unicast only; special/transitional ranges follow the IANA registries. */
export function isPublicFeedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIPv4(address);
  const words = ipv6Words(address);
  if (!words || words.length !== 8) return false;
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) return publicIPv4(`${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`);
  // Excludes compatible/mapped-private, NAT64, ULA, link-local, multicast,
  // unspecified, and the unallocated space outside current global unicast.
  if ((words[0] & 0xe000) !== 0x2000) return false;
  if ((words[0] === 0x2001 && words[1] < 0x200) || (words[0] === 0x2001 && words[1] === 0xdb8) || words[0] === 0x2002 || (words[0] === 0x3fff && words[1] < 0x1000)) return false;
  return true;
}
const canonicalAddress = (address: string) => {
  const words = ipv6Words(address);
  if (!words) return address;
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) return `${words[6] >> 8}.${words[6] & 255}.${words[7] >> 8}.${words[7] & 255}`;
  return words.join(":");
};
function interrupted<T>(promise: Promise<T>, signal: AbortSignal, milliseconds?: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new FeedError("The feed request timed out.")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    if (milliseconds) timer = setTimeout(abort, milliseconds);
    promise.then(value => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(value); }, error => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
  });
}
// Timed-out OS DNS operations retain their slots until they actually settle.
// A stalled resolver cannot leave an unbounded number of pending lookups.
let activeDNS = 0;
async function systemResolve(host: string): Promise<FeedAddress[]> {
  if (activeDNS >= 4) throw new FeedError("The feed resolver is busy. Try again later.");
  activeDNS++;
  try { return await lookup(host, { all: true, order: "verbatim" }); } finally { activeDNS--; }
}
function decode(body: Buffer, encoding: string): Buffer {
  try {
    const options = { maxOutputLength: MAX_FEED_XML_BYTES };
    const result = encoding === "gzip" || encoding === "x-gzip" ? gunzipSync(body, options) : encoding === "br" ? brotliDecompressSync(body, options) : encoding === "deflate" ? (() => { try { return inflateSync(body, options); } catch { return inflateRawSync(body, options); } })() : !encoding || encoding === "identity" ? body : null;
    if (!result || result.length > MAX_FEED_XML_BYTES) throw new Error();
    return result;
  } catch { throw new FeedError("The feed response is too large or has invalid compression."); }
}
export function createFeedTransport(options: FeedTransportOptions = {}) {
  const resolve = options.resolve || systemResolve;
  const request: Request = options.request || ((settings, callback) => (settings.protocol === "https:" ? https : http).request(settings, callback));
  let active = 0;
  const queue: Array<{ enter: () => void; abort: () => void }> = [];
  async function acquire(signal: AbortSignal) {
    if (active < 4) { active++; return; }
    if (queue.length >= 64) throw new FeedError("Feed requests are busy. Try again later.");
    await new Promise<void>((enter, reject) => {
      const pending = { enter: () => { signal.removeEventListener("abort", pending.abort); active++; enter(); }, abort: () => { const index = queue.indexOf(pending); if (index >= 0) queue.splice(index, 1); signal.removeEventListener("abort", pending.abort); reject(new FeedError("The feed request timed out.")); } };
      queue.push(pending); signal.addEventListener("abort", pending.abort, { once: true }); if (signal.aborted) pending.abort();
    });
  }
  function release() { active--; queue.shift()?.enter(); }
  async function hop(url: URL, pinned: FeedAddress, signal: AbortSignal) {
    return new Promise<{ status: number; location?: string; body?: Buffer }>((resolveHop, reject) => {
      let req: ClientRequest | undefined, response: IncomingMessage | undefined, settled = false;
      const done = (error?: Error, value?: { status: number; location?: string; body?: Buffer }) => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); if (error) { response?.destroy(); req?.destroy(); reject(error); } else resolveHop(value!); };
      const abort = () => done(new FeedError("The feed request timed out."));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      try {
        req = request({ protocol: url.protocol, hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method: "GET", agent: false, family: pinned.family, autoSelectFamily: false, maxHeaderSize: 16384,
          headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1", "Accept-Encoding": "gzip, deflate, br", "User-Agent": "WorldAct/0.4.0 RSS" },
          lookup: (_host: string, lookupOptions: any, callback: any) => { if (lookupOptions?.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family); },
          ...(url.protocol === "https:" ? { servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true } : {}),
        } as RequestOptions, message => {
          response = message;
          const status = message.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) { done(undefined, { status, location: message.headers.location }); message.destroy(); return; }
          if (status !== 200) { done(new FeedError("The feed server returned an error.")); return; }
          const length = Number(message.headers["content-length"]);
          if (Number.isFinite(length) && length > MAX_FEED_WIRE_BYTES) { done(new FeedError("The feed response is too large.")); return; }
          const chunks: Buffer[] = []; let size = 0;
          message.on("data", (chunk: Buffer) => { size += chunk.length; if (size > MAX_FEED_WIRE_BYTES) done(new FeedError("The feed response is too large.")); else chunks.push(chunk); });
          message.once("aborted", () => done(new FeedError("The feed response was interrupted.")));
          message.once("error", () => done(new FeedError("The feed response was interrupted.")));
          message.once("end", () => { if (settled) return; try { if (message.complete === false) throw new Error(); const encoding = String(message.headers["content-encoding"] || "").trim().toLowerCase(); done(undefined, { status, body: decode(Buffer.concat(chunks), encoding) }); } catch (error) { done(error instanceof FeedError ? error : new FeedError("The feed response was interrupted.")); } });
        });
        req.once("socket", socket => { socket.once("connect", () => { if (!socket.remoteAddress || canonicalAddress(socket.remoteAddress) !== canonicalAddress(pinned.address)) done(new FeedError("The feed connection could not be verified.")); }); });
        req.once("error", () => done(new FeedError("The feed could not be retrieved.")));
        req.setTimeout(4000, abort); req.end();
      } catch { done(new FeedError("The feed could not be retrieved.")); }
    });
  }
  return async (input: string, ownOrigins: ReadonlySet<string> = new Set()) => {
    const signal = AbortSignal.timeout(options.timeoutMs ?? 8000); await acquire(signal);
    try {
      let url = normalizeFeedURL(input); const visited = new Set<string>();
      for (let redirects = 0; redirects <= 3; redirects++) {
        if (signal.aborted) throw new FeedError("The feed request timed out.");
        if (visited.has(url.href)) throw new FeedError("The feed redirects in a loop."); visited.add(url.href);
        if (ownOrigins.has(url.origin)) throw new FeedError("This site URL is not a supported internal feed.");
        if (url.port && !["80", "443", "8080"].includes(url.port)) throw new FeedError("The feed URL uses an unsupported port.");
        const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
        if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new FeedError("The feed must use a public address.");
        let addresses: FeedAddress[];
        try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await interrupted(resolve(host), signal, options.dnsTimeoutMs ?? 2000); } catch (error) { throw error instanceof FeedError ? error : new FeedError("The feed host could not be resolved."); }
        if (!addresses.length || addresses.length > 64 || addresses.some(address => ![4, 6].includes(address.family) || isIP(address.address) !== address.family || !isPublicFeedAddress(address.address))) throw new FeedError("The feed must use a public address.");
        const result = await hop(url, addresses[0], signal);
        if (result.body) return { body: result.body, url: url.href };
        if (redirects === 3 || !result.location) throw new FeedError("The feed redirects too many times.");
        try { const location = result.location; if (/[\u0000-\u0020\u007f\\]/.test(location)) throw new Error(); url = normalizeFeedURL(new URL(location, url).href); } catch { throw new FeedError("The feed redirect URL is invalid."); }
      }
      throw new FeedError("The feed could not be retrieved.");
    } finally { release(); }
  };
}
export const fetchFeedDocument = createFeedTransport();
