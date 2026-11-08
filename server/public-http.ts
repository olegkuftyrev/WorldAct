import http, { type IncomingMessage, type RequestOptions, type ClientRequest } from "node:http";
import https from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { gunzipSync, inflateSync, inflateRawSync, brotliDecompressSync } from "node:zlib";

export const MAX_HTTP_WIRE_BYTES = 1024 * 1024;
export const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;
export class PublicHTTPError extends Error {}
export type PublicAddress = { address: string; family: number };
type Request = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type PublicHTTPOptions = { resolve?: (host: string) => Promise<PublicAddress[]>; request?: Request; timeoutMs?: number; dnsTimeoutMs?: number; concurrency?: number };
export type PublicHTTPInput = { waitForPhysicalClose?: boolean; representation?: "feed" | "html"; method?: "GET" | "HEAD" | "POST_XML"; body?: string; redirects?: number; maxWireBytes?: number; maxBodyBytes?: number };
export type PublicHTTPResult = { body: Buffer; url: string; status: number; headers: { pingback?: string; contentType?: string } };

export function normalizePublicURL(input: unknown): URL {
  if (typeof input !== "string" || !input || input.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(input) || !/^https?:\/\//i.test(input)) throw new PublicHTTPError("Use an absolute HTTP or HTTPS remote URL.");
  let url: URL;
  try { url = new URL(input); } catch { throw new PublicHTTPError("The remote URL is invalid."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname.includes("%")) throw new PublicHTTPError("The remote URL is invalid.");
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ""))) {
    url.hostname = url.hostname.replace(/\.$/, "");
    if (url.hostname.includes("..")) throw new PublicHTTPError("The remote URL is invalid.");
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
export function isPublicAddress(address: string): boolean {
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
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new PublicHTTPError("The remote request timed out.")); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    if (milliseconds) timer = setTimeout(abort, milliseconds);
    promise.then(value => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(value); }, error => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(error); });
  });
}
// Timed-out OS DNS operations retain their slots until they actually settle.
// A stalled resolver cannot leave an unbounded number of pending lookups.
let activeDNS = 0;
async function systemResolve(host: string): Promise<PublicAddress[]> {
  if (activeDNS >= 4) throw new PublicHTTPError("The remote resolver is busy. Try again later.");
  activeDNS++;
  try { return await lookup(host, { all: true, order: "verbatim" }); } finally { activeDNS--; }
}
function decode(body: Buffer, encoding: string, maximum: number): Buffer {
  try {
    const options = { maxOutputLength: maximum };
    const result = encoding === "gzip" || encoding === "x-gzip" ? gunzipSync(body, options) : encoding === "br" ? brotliDecompressSync(body, options) : encoding === "deflate" ? (() => { try { return inflateSync(body, options); } catch { return inflateRawSync(body, options); } })() : !encoding || encoding === "identity" ? body : null;
    if (!result || result.length > maximum) throw new Error();
    return result;
  } catch { throw new PublicHTTPError("The remote response is too large or has invalid compression."); }
}
export function createPublicHTTPTransport(options: PublicHTTPOptions = {}) {
  const resolve = options.resolve || systemResolve;
  const request: Request = options.request || ((settings, callback) => (settings.protocol === "https:" ? https : http).request(settings, callback));
  const concurrency=Math.max(1,Math.min(4,options.concurrency ?? 4));
  let active = 0;
  const queue: Array<{ enter: () => void; abort: () => void }> = [];
  async function acquire(signal: AbortSignal) {
    if (active < concurrency) { active++; return; }
    if (queue.length >= 64) throw new PublicHTTPError("Remote requests are busy. Try again later.");
    await new Promise<void>((enter, reject) => {
      const pending = { enter: () => { signal.removeEventListener("abort", pending.abort); active++; enter(); }, abort: () => { const index = queue.indexOf(pending); if (index >= 0) queue.splice(index, 1); signal.removeEventListener("abort", pending.abort); reject(new PublicHTTPError("The remote request timed out.")); } };
      queue.push(pending); signal.addEventListener("abort", pending.abort, { once: true }); if (signal.aborted) pending.abort();
    });
  }
  function release() { active--; queue.shift()?.enter(); }
  async function hop(url: URL, pinned: PublicAddress, signal: AbortSignal, input: PublicHTTPInput, track: (req: ClientRequest) => void) {
    return new Promise<{ status: number; location?: string; body?: Buffer; headers?: PublicHTTPResult["headers"] }>((resolveHop, reject) => {
      let req: ClientRequest | undefined, response: IncomingMessage | undefined, settled = false;
      const done = (error?: Error, value?: { status: number; location?: string; body?: Buffer; headers?: PublicHTTPResult["headers"] }) => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); if (error) { response?.destroy(); req?.destroy(); reject(error); } else resolveHop(value!); };
      const abort = () => done(new PublicHTTPError("The remote request timed out."));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      try {
        req = request({ protocol: url.protocol, hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method: input.method === "POST_XML" ? "POST" : input.method || "GET", agent: false, family: pinned.family, autoSelectFamily: false, maxHeaderSize: 16384,
          headers: { Accept: input.method === "POST_XML" ? "text/xml, application/xml;q=0.9" : input.representation === "html" ? "text/html, application/xhtml+xml;q=0.9, */*;q=0.1" : "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1", "Accept-Encoding": "gzip, deflate, br", "User-Agent": "WorldAct/0.4.0", ...(input.method === "POST_XML" ? { "Content-Type": "text/xml; charset=UTF-8", "Content-Length": Buffer.byteLength(input.body || "") } : {}) },
          lookup: (_host: string, lookupOptions: any, callback: any) => { if (lookupOptions?.all) callback(null, [pinned]); else callback(null, pinned.address, pinned.family); },
          ...(url.protocol === "https:" ? { servername: isIP(hostname) ? undefined : hostname, rejectUnauthorized: true } : {}),
        } as RequestOptions, message => {
          if(settled){message.destroy();return;}
          response = message;
          const status = message.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status)) { done(undefined, { status, location: message.headers.location }); message.destroy(); return; }
          if (status !== 200 && !(input.method === "HEAD" && [204,405,501].includes(status))) { done(new PublicHTTPError("The remote server returned an error.")); return; }
          const length = Number(message.headers["content-length"]);
          if (input.method !== "HEAD" && Number.isFinite(length) && length > (input.maxWireBytes ?? MAX_HTTP_WIRE_BYTES)) { done(new PublicHTTPError("The remote response is too large.")); return; }
          const chunks: Buffer[] = []; let size = 0;
          message.on("data", (chunk: Buffer) => { size += chunk.length; if (size > (input.maxWireBytes ?? MAX_HTTP_WIRE_BYTES)) done(new PublicHTTPError("The remote response is too large.")); else chunks.push(chunk); });
          message.once("aborted", () => done(new PublicHTTPError("The remote response was interrupted.")));
          message.once("error", () => done(new PublicHTTPError("The remote response was interrupted.")));
          message.once("end", () => { if (settled) return; try { if (message.complete === false) throw new Error(); const encoding = String(message.headers["content-encoding"] || "").trim().toLowerCase(); done(undefined, { status, headers: { pingback: typeof message.headers["x-pingback"] === "string" && message.headers["x-pingback"].length <= 2048 ? message.headers["x-pingback"] : undefined, contentType: String(message.headers["content-type"] || "").slice(0,200) || undefined }, body: input.method === "HEAD" ? Buffer.alloc(0) : decode(Buffer.concat(chunks), encoding, input.maxBodyBytes ?? MAX_HTTP_BODY_BYTES) }); } catch (error) { done(error instanceof PublicHTTPError ? error : new PublicHTTPError("The remote response was interrupted.")); } });
        });
        track(req);
        req.once("socket", socket => { socket.once("connect", () => { if (!socket.remoteAddress || canonicalAddress(socket.remoteAddress) !== canonicalAddress(pinned.address)) done(new PublicHTTPError("The remote connection could not be verified.")); }); });
        req.once("error", () => done(new PublicHTTPError("The remote could not be retrieved.")));
        req.setTimeout(4000, abort); req.end(input.method === "POST_XML" ? input.body : undefined);
      } catch { done(new PublicHTTPError("The remote could not be retrieved.")); }
    });
  }
  return async (urlInput: string, input: PublicHTTPInput = {}, ownOrigins: ReadonlySet<string> = new Set()): Promise<PublicHTTPResult> => {
    if ((input.waitForPhysicalClose!==undefined && typeof input.waitForPhysicalClose!=="boolean") || ![undefined,"feed","html"].includes(input.representation) || ![undefined,"GET","HEAD","POST_XML"].includes(input.method) || (input.redirects!==undefined && (!Number.isInteger(input.redirects) || input.redirects<0 || input.redirects>3)) || [input.maxWireBytes,input.maxBodyBytes].some(value=>value!==undefined && (!Number.isInteger(value) || value<1 || value>MAX_HTTP_BODY_BYTES)) || (input.body && (input.method !== "POST_XML" || Buffer.byteLength(input.body)>8192))) throw new PublicHTTPError("The remote request is invalid.");
    const signal = AbortSignal.timeout(options.timeoutMs ?? 8000); await acquire(signal);
    let releaseWanted=false, released=false; const pending=new Set<ClientRequest>();
    const maybeRelease=()=>{if(releaseWanted && !pending.size && !released){released=true;release();}};
    const physicalCloses=new Map<ClientRequest,Promise<void>>();
    const track=(req:ClientRequest)=>{
      pending.add(req);let hasSocket=false;
      const closed=new Promise<void>(done=>{
        const releasePhysical=()=>{pending.delete(req);physicalCloses.delete(req);maybeRelease();done();};
        req.once("socket",socket=>{hasSocket=true;socket.once("close",releasePhysical);});
        req.once("close",()=>{if(!hasSocket)releasePhysical();});
      });physicalCloses.set(req,closed);
    };
    try {
      let url = normalizePublicURL(urlInput); const visited = new Set<string>();
      for (let redirects = 0; redirects <= (input.redirects ?? 3); redirects++) {
        if (signal.aborted) throw new PublicHTTPError("The remote request timed out.");
        if (visited.has(url.href)) throw new PublicHTTPError("The remote redirects in a loop."); visited.add(url.href);
        if (ownOrigins.has(url.origin)) throw new PublicHTTPError("This site URL is not a supported internal remote.");
        if (url.port && !["80", "443", "8080"].includes(url.port)) throw new PublicHTTPError("The remote URL uses an unsupported port.");
        const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
        if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new PublicHTTPError("The remote must use a public address.");
        let addresses: PublicAddress[];
        try { addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await interrupted(resolve(host), signal, options.dnsTimeoutMs ?? 2000); } catch (error) { throw error instanceof PublicHTTPError ? error : new PublicHTTPError("The remote host could not be resolved."); }
        if (!addresses.length || addresses.length > 64 || addresses.some(address => ![4, 6].includes(address.family) || isIP(address.address) !== address.family || !isPublicAddress(address.address))) throw new PublicHTTPError("The remote must use a public address.");
        const result = await hop(url, addresses[0], signal, input, track);
        if (result.body) return { body: result.body, url: url.href, status: result.status, headers: result.headers || {} };
        // Redirects do not temporarily exceed the physical connection reservation.
        if (pending.size) await interrupted(Promise.all([...physicalCloses.values()]),signal);
        if (redirects === (input.redirects ?? 3) || !result.location) throw new PublicHTTPError("The remote redirects too many times.");
        try { const location = result.location; if (/[\u0000-\u0020\u007f\\]/.test(location)) throw new Error(); url = normalizePublicURL(new URL(location, url).href); } catch { throw new PublicHTTPError("The remote redirect URL is invalid."); }
      }
      throw new PublicHTTPError("The remote could not be retrieved.");
    } finally { if(input.waitForPhysicalClose && pending.size)await Promise.all([...physicalCloses.values()]);releaseWanted=true;maybeRelease(); }
  };
}
export const publicHTTP = createPublicHTTPTransport({concurrency:2});
