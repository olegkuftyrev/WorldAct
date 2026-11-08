import { MAX_POP3_MESSAGE_BYTES } from "./pop3.js";
import { z } from "zod";
export class MailMessageError extends Error {
  constructor(readonly outcome: "limits" | "invalid_message" | "unsupported_message") { super("Mailbox message could not be imported: " + outcome.replaceAll("_", " ") + "."); }
}
type Header = { name: string; value: string };
type Part = { headers: Header[]; body: Buffer };
const relevant = new Set(["subject", "from", "reply-to", "date", "content-type", "content-transfer-encoding", "content-disposition"]);
function splitMessage(raw: Buffer): Part {
  const end = raw.indexOf("\r\n\r\n");
  if (end < 0) throw new MailMessageError("invalid_message");
  if (end > 32 * 1024) throw new MailMessageError("limits");
  const headers: Header[] = [], seen = new Set<string>();
  for (const line of raw.subarray(0, end).toString("latin1").split("\r\n")) {
    if (/^[ \t]/.test(line)) {
      if (!headers.length) throw new MailMessageError("invalid_message");
      headers.at(-1)!.value += " " + line.trim();
    } else {
      const match = /^([A-Za-z0-9-]{1,78}):[ \t]*(.*)$/.exec(line);
      if (!match || headers.length >= 100) throw new MailMessageError("invalid_message");
      const name = match[1].toLowerCase();
      if (relevant.has(name) && seen.has(name)) throw new MailMessageError("invalid_message");
      seen.add(name); headers.push({ name, value: match[2].trim() });
    }
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(line)) throw new MailMessageError("invalid_message");
  }
  return { headers, body: raw.subarray(end + 4) };
}
const get = (part: Part, name: string) => part.headers.find(item => item.name === name)?.value || "";
function headerParameters(value: string, index: number) {
  if (value.length > 2048) throw new MailMessageError("limits");
  const parameters = new Map<string, string>(), parameter = /\s*;\s*([A-Za-z0-9_*.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([!#$%&'*+.^_`{|}~A-Za-z0-9-]+))\s*/y;
  while (index < value.length) {
    parameter.lastIndex = index;
    const item = parameter.exec(value);
    if (!item || parameters.size >= 16 || parameters.has(item[1].toLowerCase())) throw new MailMessageError("invalid_message");
    parameters.set(item[1].toLowerCase(), item[2] === undefined ? item[3] : item[2].replace(/\\(.)/g, "$1"));
    index = parameter.lastIndex;
  }
  return parameters;
}
function contentType(value: string) {
  if (!value) return { type: "text/plain", parameters: new Map<string, string>() };
  const match = /^([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+)/.exec(value);
  if (!match) throw new MailMessageError("invalid_message");
  return { type: match[1].toLowerCase(), parameters: headerParameters(value, match[0].length) };
}
function quotedPrintable(input: Buffer) {
  const result = Buffer.allocUnsafe(input.length); let length = 0;
  for (let index = 0; index < input.length; index++) {
    if (input[index] !== 61) { result[length++] = input[index]; continue; }
    if (input[index + 1] === 13 && input[index + 2] === 10) { index += 2; continue; }
    const pair = input.subarray(index + 1, index + 3).toString("latin1");
    if (pair.length !== 2 || !/^[0-9a-f]{2}$/i.test(pair)) throw new MailMessageError("invalid_message");
    result[length++] = parseInt(pair, 16); index += 2;
  }
  return result.subarray(0, length);
}
function transfer(body: Buffer, encoding: string) {
  switch (encoding.trim().toLowerCase()) {
    case "": case "7bit": case "8bit": case "binary": return body;
    case "quoted-printable": return quotedPrintable(body);
    case "base64": {
      const text = body.toString("latin1").replace(/[ \t\r\n]/g, "");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) throw new MailMessageError("invalid_message");
      const decoded = Buffer.from(text, "base64");
      if (decoded.toString("base64") !== text) throw new MailMessageError("invalid_message");
      return decoded;
    }
    default: throw new MailMessageError("unsupported_message");
  }
}
function decode(body: Buffer, charset = "utf-8") {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(charset)) throw new MailMessageError("unsupported_message");
  // TextDecoder's WHATWG aliases map ISO-8859-1 to Windows-1252. Preserve the
  // actual declared Latin-1 bytes, including C1, before the storage sanitizer.
  if (/^(?:iso-8859-1|latin1)$/i.test(charset)) return body.toString("latin1");
  if (/^(?:us-ascii|ascii)$/i.test(charset) && body.some(byte => byte > 127)) throw new MailMessageError("invalid_message");
  try { return new TextDecoder(charset, { fatal: true }).decode(body); }
  catch { throw new MailMessageError("unsupported_message"); }
}
export function decodeMailSubject(input: string) {
  if (input.length > 8192) throw new MailMessageError("limits");
  if (/[^\x00-\x7f]/.test(input)) input = decode(Buffer.from(input, "latin1"));
  let count = 0;
  return input.replace(/(\?=)[ \t]+(?==\?)/g, "$1").replace(/=\?([^?\s]{1,40})\?([bq])\?([^?\s]{1,2048})\?=/gi, (_match, charset: string, encoding: string, text: string) => {
    if (++count > 32) throw new MailMessageError("limits");
    return decode(transfer(Buffer.from(encoding.toLowerCase() === "q" ? text.replaceAll("_", " ") : text, "latin1"), encoding.toLowerCase() === "q" ? "quoted-printable" : "base64"), charset);
  });
}
function selectBody(part: Part, budget: { nodes: number; bytes: number }, depth = 0): { body: string; isHTML: boolean } {
  if (++budget.nodes > 16 || depth > 4) throw new MailMessageError("limits");
  const format = contentType(get(part, "content-type"));
  const disposition = get(part, "content-disposition");
  if (disposition) {
    const kind = /^inline(?=\s*(?:;|$))/i.exec(disposition);
    if (!kind) throw new MailMessageError("unsupported_message");
    let parameters: Map<string, string>;
    try { parameters = headerParameters(disposition, kind[0].length); }
    catch { throw new MailMessageError("unsupported_message"); }
    if ([...parameters.keys()].some(key => /^filename(?:\*|$)/.test(key))) throw new MailMessageError("unsupported_message");
  }
  if (format.type === "multipart/alternative") {
    const encoding = get(part, "content-transfer-encoding").toLowerCase();
    if (encoding && !["7bit", "8bit", "binary"].includes(encoding)) throw new MailMessageError("unsupported_message");
    const boundary = format.parameters.get("boundary");
    if (!boundary || !/^[A-Za-z0-9'()+_,./:=? -]{1,70}$/.test(boundary) || boundary.endsWith(" ")) throw new MailMessageError("invalid_message");
    const source = "\r\n" + part.body.toString("latin1"), escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), marker = new RegExp("\\r\\n--" + escaped + "(--)?[ \\t]*(?:\\r\\n|$)", "g");
    let previous = -1, ended = false, parts = 0, choice: ReturnType<typeof selectBody> | undefined;
    for (const match of source.matchAll(marker)) {
      if (previous >= 0) {
        if (++parts > 8) throw new MailMessageError("limits");
        const child = selectBody(splitMessage(Buffer.from(source.slice(previous, match.index), "latin1")), budget, depth + 1);
        if (!choice || child.isHTML) choice = child;
      }
      if (match[1]) { ended = true; break; }
      previous = match.index + match[0].length;
    }
    if (!ended || !choice) throw new MailMessageError("invalid_message");
    return choice;
  }
  if (!["text/plain", "text/html"].includes(format.type) || [...format.parameters.keys()].some(key => /^(?:name|charset)(?:\*|$)/.test(key) && key !== "charset")) throw new MailMessageError("unsupported_message");
  const decoded = transfer(part.body, get(part, "content-transfer-encoding"));
  budget.bytes += decoded.length;
  if (budget.bytes > MAX_POP3_MESSAGE_BYTES) throw new MailMessageError("limits");
  const body = decode(decoded, format.parameters.get("charset") || "utf-8");
  if (body.includes("\u0000")) throw new MailMessageError("invalid_message");
  return { body: body.trim(), isHTML: format.type === "text/html" };
}
/** Parsing alone grants no sender identity, publishing permission or deletion. */
export function parseMailMessage(raw: Buffer) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_POP3_MESSAGE_BYTES) throw new MailMessageError("limits");
  const part = splitMessage(raw), body = selectBody(part, { nodes: 0, bytes: 0 });
  if (!body.body) throw new MailMessageError("invalid_message");
  const senders = part.headers.filter(item => ["from", "reply-to"].includes(item.name)).flatMap(item => {
    const value = item.value.trim(), mailbox = z.email().max(254);
    if (mailbox.safeParse(value).success) return [value.toLowerCase()];
    const angle = /^(.*?)<([^<>]+)>$/.exec(value);
    if (!angle) return [];
    const display = angle[1].trim();
    if (display && !(/^"(?:[^"\\]|\\[\x20-\x7e])*"$/.test(display) || /^[^<>,@()"\\]+$/.test(display))) return [];
    const address = angle[2].trim();
    return mailbox.safeParse(address).success ? [address.toLowerCase()] : [];
  });
  const originalSubject = decodeMailSubject(get(part, "subject")), delimiter = originalSubject.indexOf("::");
  const subject = (delimiter < 0 ? originalSubject : originalSubject.slice(0, delimiter)).trim();
  const dateHeader = get(part, "date").replace(/\s*\([^)]*\)\s*$/, ""), timestamp = dateHeader.length <= 200 ? Date.parse(dateHeader) : NaN;
  return { ...body, subject, senderCandidates: senders, date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null };
}
