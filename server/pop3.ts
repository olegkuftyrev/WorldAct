import { connect as tcpConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { lookup } from "node:dns/promises";
import { canonicalAddress, isPublicAddress, type PublicAddress } from "./public-http.js";

export class POP3Error extends Error {
  constructor(readonly outcome: "configuration" | "busy" | "unavailable" | "authentication" | "invalid_reply" | "limits") { super("Mailbox " + outcome.replaceAll("_", " ") + "."); }
}
export type POP3Configuration = { host: string; port: 110 | 995; secure: boolean; username: string; password: string };
export type POP3Message = { number: number; uid: string; size: number };
export const MAX_POP3_MESSAGE_BYTES = 1024 * 1024, MAX_POP3_SESSION_BYTES = 8 * 1024 * 1024;
type ConnectInput = { host: string; port: number; secure: boolean; pinned: PublicAddress };
type Options = {
  resolve?: (host: string) => Promise<PublicAddress[]>;
  connect?: (input: ConnectInput) => Socket;
  deadlineMs?: number;
  waitForPhysicalClose?: boolean;
};
export function normalizePOP3Configuration(input: POP3Configuration): POP3Configuration {
  if (!input || typeof input.host !== "string" || input.host.length > 253 || !input.host || /[\u0000-\u0020\u007f/@\\?#%]/.test(input.host) ||
      typeof input.secure !== "boolean" || input.port !== (input.secure ? 995 : 110) ||
      ![input.username, input.password].every(value => typeof value === "string" && value.length > 0 && value.length <= 1024 && /^[\x20-\x7e]+$/.test(value)))
    throw new POP3Error("configuration");
  let host: string;
  try {
    const ipv6 = isIP(input.host) === 6 || (input.host.startsWith("[") && input.host.endsWith("]") && isIP(input.host.slice(1, -1)) === 6);
    if (input.host.includes(":") && !ipv6) throw new Error();
    const url = new URL("https://" + (isIP(input.host) === 6 ? "[" + input.host + "]" : input.host));
    if (url.port || url.pathname !== "/" || url.username || url.password) throw new Error();
    host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch { throw new POP3Error("configuration"); }
  if (host === "localhost" || /\.(localhost|local|internal)$/.test(host) || host.includes("..") || (isIP(host) && !isPublicAddress(host))) throw new POP3Error("configuration");
  return { ...input, host };
}
function interrupted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(new POP3Error("unavailable")); };
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}
let activeDNS = 0;
async function resolvePublic(host: string, resolve: NonNullable<Options["resolve"]>) {
  if (isIP(host)) return [{ address: host, family: isIP(host) }];
  if (activeDNS >= 2) throw new POP3Error("busy");
  activeDNS++;
  try {
    const addresses = await resolve(host);
    if (!addresses.length || addresses.length > 64 || addresses.some(item => isIP(item.address) !== item.family || ![4, 6].includes(item.family) || !isPublicAddress(item.address))) throw new POP3Error("configuration");
    return addresses;
  } finally { activeDNS--; }
}
export function pop3SocketOptions({ host, port, secure, pinned }: ConnectInput) {
  return {
    host, port, family: pinned.family, autoSelectFamily: false,
    lookup: (_name: string, input: any, callback: any) => input?.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
    ...(secure ? { servername: isIP(host) ? undefined : host, rejectUnauthorized: true } : {}),
  };
}
function connectPublic(input: ConnectInput): Socket {
  const options = pop3SocketOptions(input);
  return input.secure ? tlsConnect(options) : tcpConnect(options);
}
/** Fixed RFC 1939 commands, never a caller-supplied command or endpoint protocol. */
export function createPOP3Transport(options: Options = {}) {
  let active = false;
  return async (input: POP3Configuration) => {
    const configuration = normalizePOP3Configuration(input);
    if (active) throw new POP3Error("busy");
    active = true;
    const signal = AbortSignal.timeout(options.deadlineMs ?? 30_000);
    let socket: Socket | undefined, failure: POP3Error | undefined, wireBytes = 0, lineCount = 0;
    let partial = Buffer.alloc(0), lines: Buffer[] = [], head = 0;
    let waiting: { resolve: (line: Buffer) => void; reject: (error: POP3Error) => void } | undefined;
    let rejectConnection: ((error: POP3Error) => void) | undefined;
    let finishClose!: () => void;
    const closed = new Promise<void>(resolve => { finishClose = resolve; });
    const fail = (error: POP3Error) => {
      failure ??= error;
      waiting?.reject(failure); waiting = undefined;
      rejectConnection?.(failure); rejectConnection = undefined;
      socket?.destroy();
    };
    const abort = () => fail(new POP3Error("unavailable"));
    signal.addEventListener("abort", abort, { once: true });
    const line = async () => {
      if (failure || signal.aborted) throw failure || new POP3Error("unavailable");
      if (head < lines.length) {
        const value = lines[head++];
        if (head === lines.length) { lines = []; head = 0; }
        return value;
      }
      if (waiting) throw new POP3Error("invalid_reply");
      return new Promise<Buffer>((resolve, reject) => { waiting = { resolve, reject }; });
    };
    const status = async (authentication = false) => {
      const value = await line();
      if (value.length > 510) throw new POP3Error("limits");
      const text = value.toString("latin1");
      if (!/^[\x20-\x7e]*$/.test(text)) throw new POP3Error("invalid_reply");
      if (/^-ERR(?: |$)/.test(text)) throw new POP3Error(authentication ? "authentication" : "unavailable");
      if (!/^\+OK(?: |$)/.test(text)) throw new POP3Error("invalid_reply");
      return text;
    };
    const command = async (value: string, authentication = false) => {
      if (failure || signal.aborted) throw failure || new POP3Error("unavailable");
      socket!.write(value + "\r\n", "ascii");
      return status(authentication);
    };
    const multiline = async (maximum: number, maximumLines: number) => {
      const chunks: Buffer[] = []; let size = 0;
      while (true) {
        let value = await line();
        if (value.length === 1 && value[0] === 46) break;
        if (value[0] === 46) value = value.subarray(1);
        size += value.length + 2;
        if (size > maximum || chunks.length >= maximumLines) throw new POP3Error("limits");
        chunks.push(Buffer.concat([value, Buffer.from("\r\n")]));
      }
      return Buffer.concat(chunks, size);
    };
    let serial: Promise<unknown> = Promise.resolve();
    const run = <T>(work: () => Promise<T>): Promise<T> => {
      const result = serial.then(work).catch(error => {
        const safe = error instanceof POP3Error ? error : new POP3Error("unavailable"); fail(safe); throw safe;
      });
      serial = result.catch(() => {});
      return result;
    };
    try {
      const addresses = await interrupted(resolvePublic(configuration.host, options.resolve || (host => lookup(host, { all: true, order: "verbatim" }))), signal);
      if (signal.aborted) throw new POP3Error("unavailable");
      const pinned = addresses[0];
      if (!isPublicAddress(pinned.address)) throw new POP3Error("configuration");
      socket = (options.connect || connectPublic)({ host: configuration.host, port: configuration.port, secure: configuration.secure, pinned });
      socket.once("close", () => {
        active = false; signal.removeEventListener("abort", abort);
        if (!failure) fail(new POP3Error("unavailable"));
        finishClose();
      });
      socket.once("error", () => fail(new POP3Error("unavailable")));
      socket.setTimeout(5000, abort);
      socket.on("data", (chunk: Buffer) => {
        if (failure) return;
        wireBytes += chunk.length;
        if (wireBytes > MAX_POP3_SESSION_BYTES) { fail(new POP3Error("limits")); return; }
        const buffer = partial.length ? Buffer.concat([partial, chunk]) : chunk;
        let start = 0, end: number;
        while ((end = buffer.indexOf("\r\n", start)) >= 0) {
          if (end - start > 16384 || ++lineCount > 50_000) { fail(new POP3Error("limits")); return; }
          const value = Buffer.from(buffer.subarray(start, end)); start = end + 2;
          if (waiting) { const pending = waiting; waiting = undefined; pending.resolve(value); } else lines.push(value);
        }
        partial = Buffer.from(buffer.subarray(start));
        if (partial.length > 16384) fail(new POP3Error("limits"));
      });
      await interrupted(new Promise<void>((resolve, reject) => {
        rejectConnection = reject;
        socket!.once(configuration.secure ? "secureConnect" : "connect", () => {
          if (failure) { reject(failure); return; }
          if (!socket!.remoteAddress || !isPublicAddress(socket!.remoteAddress) || canonicalAddress(socket!.remoteAddress) !== canonicalAddress(pinned.address) ||
              (configuration.secure && (socket as TLSSocket).authorized !== true)) {
            fail(new POP3Error("configuration")); return;
          }
          rejectConnection = undefined; resolve();
        });
      }), signal);
      await status();
      await command("USER " + configuration.username, true);
      await command("PASS " + configuration.password, true);
      return {
        closed,
        list: () => run(async (): Promise<POP3Message[]> => {
          await command("UIDL");
          const uids = (await multiline(128 * 1024, 1000)).toString("latin1").split("\r\n").filter(Boolean);
          const messages = new Map<number, POP3Message>(), used = new Set<string>();
          for (const entry of uids) {
            const match = /^([1-9]\d{0,9}) ([\x21-\x7e]{1,70})$/.exec(entry);
            if (!match || Number(match[1]) > 2147483647 || used.has(match[2]) || messages.has(Number(match[1]))) throw new POP3Error("invalid_reply");
            used.add(match[2]); messages.set(Number(match[1]), { number: Number(match[1]), uid: match[2], size: -1 });
          }
          await command("LIST");
          const sizes = (await multiline(64 * 1024, 1000)).toString("latin1").split("\r\n").filter(Boolean), seen = new Set<number>();
          for (const entry of sizes) {
            const match = /^([1-9]\d{0,9}) (0|[1-9]\d{0,9})$/.exec(entry), item = match && messages.get(Number(match[1]));
            if (!match || !item || seen.has(item.number)) throw new POP3Error("invalid_reply");
            item.size = Number(match[2]); seen.add(item.number);
          }
          if (seen.size !== messages.size) throw new POP3Error("invalid_reply");
          return [...messages.values()].sort((a, b) => a.number - b.number);
        }),
        retrieve: (number: number) => run(async () => {
          if (!Number.isInteger(number) || number < 1 || number > 2147483647) throw new POP3Error("configuration");
          await command("RETR " + number); return multiline(MAX_POP3_MESSAGE_BYTES, 20_000);
        }),
        remove: (number: number) => run(async () => {
          if (!Number.isInteger(number) || number < 1 || number > 2147483647) throw new POP3Error("configuration");
          await command("DELE " + number);
        }),
        quit: () => run(async () => { await command("QUIT"); socket!.end(); await interrupted(closed, signal); }),
        abort: () => { fail(new POP3Error("unavailable")); return closed; },
      };
    } catch (error) {
      const safe = error instanceof POP3Error ? error : new POP3Error("unavailable");
      fail(safe);
      if (!socket) { active = false; signal.removeEventListener("abort", abort); finishClose(); }
      if (options.waitForPhysicalClose) await closed;
      throw safe;
    }
  };
}
export const openPOP3 = createPOP3Transport({ waitForPhysicalClose: true });
