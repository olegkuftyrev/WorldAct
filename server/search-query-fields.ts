import { HttpError } from "./utils.js";

// Supplied KSES names minus apos: the 252 case-sensitive HTML 4.01 names
// accepted by the source esc_attr/ENT_QUOTES, double_encode=false pipeline.
// This is deliberately not an HTML5 entity decoder.
const html401Names = new Set(`
nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn
acute micro para middot cedil ordm raquo iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute
Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc
Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute
icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml
quot amp lt gt OElig oelig Scaron scaron Yuml circ tilde ensp emsp thinsp zwnj zwj lrm rlm
ndash mdash lsquo rsquo sbquo ldquo rdquo bdquo dagger Dagger permil lsaquo rsaquo euro fnof Alpha Beta Gamma
Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho Sigma Tau Upsilon Phi
Chi Psi Omega alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron
pi rho sigmaf sigma tau upsilon phi chi psi omega thetasym upsih piv bull hellip prime Prime oline
frasl weierp image real trade alefsym larr uarr rarr darr harr crarr lArr uArr rArr dArr hArr forall
part exist empty nabla isin notin ni prod sum minus lowast radic prop infin ang and or cap
cup int sim cong asymp ne equiv le ge sub sup nsub sube supe oplus otimes perp sdot
lceil rceil lfloor rfloor lang rang loz spades clubs hearts diams sup1 sup2 sup3 frac14 frac12 frac34 there4
`.trim().split(/\s+/));
const hiddenStart = '<input type="hidden" name="';
const hiddenMiddle = '" value="';
const hiddenEnd = '">';
const limitMessage = "Rendered content exceeds the 8 MiB limit. Reduce repeated patterns or query output.";
const tooLarge = () => { throw new HttpError(413, limitMessage); };
const validUnicode = (n: number) => n === 9 || n === 10 || n === 13 || n >= 0x20 && n <= 0xd7ff || n >= 0xe000 && n <= 0xfffd || n >= 0x10000 && n <= 0x10ffff;
const digit = (code: number, hex: boolean) => code >= 48 && code <= 57 ? code - 48 : hex && code >= 65 && code <= 70 ? code - 55 : hex && code >= 97 && code <= 102 ? code - 87 : -1;
type Reference = { end: number; text: string } | { end: number; prefix: string; from: number; to: number };

/** Inspect original input only; leading-zero runs are indices, never copies. */
function referenceAt(input: string, amp: number): Reference | undefined {
  if (input.charCodeAt(amp + 1) === 35) {
    let at = amp + 2;
    const hex = input[at] === "x" || input[at] === "X";
    if (hex) at++;
    const from = at;
    while (input.charCodeAt(at) === 48) at++;
    const significant = at;
    let value = 0, digits = 0;
    for (;;) {
      const next = digit(input.charCodeAt(at), hex);
      if (next < 0) break;
      if (++digits > (hex ? 6 : 7)) return;
      value = value * (hex ? 16 : 10) + next;
      at++;
    }
    if (!digits || input[at] !== ";") return;
    if (validUnicode(value)) {
      const number = input.slice(significant, at);
      return { end: at + 1, text: hex ? "&#x" + number + ";" : "&#" + number.padStart(3, "0") + ";" };
    }
    // A matching invalid hex token normalizes X, but retains captured zeros.
    // An unmatched all-zero token instead keeps its original spelling.
    return { end: at + 1, prefix: hex ? "&amp;#x" : "&amp;#", from, to: at };
  }
  let at = amp + 1, letters = 0, digits = 0;
  while (/[A-Za-z]/.test(input[at] || "")) { if (++letters > 8) return; at++; }
  while (/[0-9]/.test(input[at] || "")) { if (++digits > 2) return; at++; }
  if (letters >= 2 && input[at] === ";" && html401Names.has(input.slice(amp + 1, at)))
    return { end: at + 1, text: input.slice(amp, at + 1) };
}

type Writer = { text(value: string): void; span(value: string, from: number, to: number): void };
/** Same token walk sizes and emits, without decoding/rescanning generated text. */
function escapedBytes(input: string, allowance: number, writer?: Writer): number {
  let bytes = 0, at = 0, plain = 0;
  const charge = (n: number) => { if (n > allowance - bytes) tooLarge(); bytes += n; };
  const flush = () => { if (writer && plain < at) writer.span(input, plain, at); };
  while (at < input.length) {
    const code = input.charCodeAt(at);
    let replacement: string | undefined;
    if (code === 38) {
      const ref = referenceAt(input, at);
      flush();
      if (ref) {
        if ("text" in ref) { charge(ref.text.length); writer?.text(ref.text); }
        else { charge(ref.prefix.length + ref.to - ref.from + 1); writer?.text(ref.prefix); writer?.span(input, ref.from, ref.to); writer?.text(";"); }
        at = ref.end;
      } else { charge(5); writer?.text("&amp;"); at++; }
      plain = at;
      continue;
    }
    if (code === 60) replacement = "&lt;";
    else if (code === 62) replacement = "&gt;";
    else if (code === 34) replacement = "&quot;";
    else if (code === 39) replacement = "&#039;";
    if (replacement) {
      flush(); charge(replacement.length); writer?.text(replacement); at++; plain = at;
    } else if (code >= 0xd800 && code <= 0xdbff && input.charCodeAt(at + 1) >= 0xdc00 && input.charCodeAt(at + 1) <= 0xdfff) {
      charge(4); at += 2;
    } else { charge(code < 0x80 ? 1 : code < 0x800 ? 2 : 3); at++; }
  }
  flush();
  return bytes;
}
function scalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === false) return "";
  if (value === true) return "1";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "object") return "Array";
  // Saved/preview inputs are JSON. Do not call arbitrary getters/toString.
}

/** Escape one selected title term after reserving its complete heading markup. */
export function escapeSearchQueryTitleTerm(term: string, remainingBytes: number, surroundingBytes: number): string {
  const allowance = remainingBytes - surroundingBytes;
  if (!Number.isFinite(remainingBytes) || !Number.isFinite(surroundingBytes) || surroundingBytes < 0 || allowance < 0) tooLarge();
  escapedBytes(term, allowance);
  const parts: string[] = [];
  let chunk = "";
  const writer: Writer = {
    text(value) { this.span(value, 0, value.length); },
    span(value, from, to) {
      while (from < to) {
        const end = Math.min(to, from + 8192 - chunk.length);
        chunk += value.slice(from, end); from = end;
        if (chunk.length === 8192) { parts.push(chunk); chunk = ""; }
      }
    },
  };
  escapedBytes(term, allowance, writer);
  if (chunk) parts.push(chunk);
  return parts.join("");
}

/**
 * Own explicit JSON query only. Preflight the complete form before creating
 * escaped fields; the caller's normal renderer remains the sole output charge.
 */
export function searchQueryFieldParts(query: unknown, remainingBytes: number, surroundingBytes: number): string[] {
  let bytes = surroundingBytes;
  const charge = (n: number) => { if (n > remainingBytes - bytes) tooLarge(); bytes += n; };
  charge(0);
  const fields: Array<[string, string]> = [];
  if (query !== null && typeof query === "object") {
    for (const name of Object.keys(query)) {
      const descriptor = Object.getOwnPropertyDescriptor(query, name);
      if (!descriptor?.enumerable || !("value" in descriptor)) continue;
      const value = scalar(descriptor.value);
      if (value === undefined) continue;
      charge(hiddenStart.length + hiddenMiddle.length + hiddenEnd.length);
      charge(escapedBytes(name, remainingBytes - bytes));
      charge(escapedBytes(value, remainingBytes - bytes));
      fields.push([name, value]);
    }
  }
  // No field escaped before the whole preflight. Chunking also avoids a large
  // per-character array when an accepted string consists entirely of '&'.
  const parts: string[] = [];
  let chunk = "";
  const writer: Writer = {
    text(value) { this.span(value, 0, value.length); },
    span(value, from, to) {
      while (from < to) {
        const end = Math.min(to, from + 8192 - chunk.length);
        chunk += value.slice(from, end); from = end;
        if (chunk.length === 8192) { parts.push(chunk); chunk = ""; }
      }
    },
  };
  for (const [name, value] of fields) {
    writer.text(hiddenStart); escapedBytes(name, remainingBytes, writer);
    writer.text(hiddenMiddle); escapedBytes(value, remainingBytes, writer);
    writer.text(hiddenEnd);
  }
  if (chunk) parts.push(chunk);
  return parts;
}
