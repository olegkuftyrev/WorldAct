// MathML Core elements and the presentation attributes used by the supplied
// WordPress KSES list. No links, XML integration points or embedded resources.
const globals = ["displaystyle", "scriptlevel", "mathbackground", "mathcolor", "mathsize", "dir"];
const extra: Record<string, string[]> = {
  math: ["display", "xmlns"], mtext: [], mi: ["mathvariant"], mn: [],
  mo: ["form", "fence", "separator", "lspace", "rspace", "stretchy", "symmetric", "maxsize", "minsize", "largeop", "movablelimits"],
  mspace: ["width", "height", "depth"], ms: [], mrow: [], mfrac: ["linethickness"], msqrt: [], mroot: [], mstyle: [], merror: [],
  mpadded: ["width", "height", "depth", "lspace", "voffset"], mphantom: [], msub: [], msup: [], msubsup: [],
  munder: ["accentunder", "accent"], mover: ["accentunder", "accent"], munderover: ["accentunder", "accent"], mmultiscripts: [], mprescripts: [],
  mtable: ["columnalign", "rowspacing", "columnspacing", "align", "rowalign", "columnlines", "rowlines", "frame", "framespacing", "width"],
  mtr: ["columnalign", "rowalign"], mtd: ["columnspan", "rowspan", "columnalign", "rowalign"], semantics: [], annotation: ["encoding"], menclose: ["notation"],
};
export const mathMLTags = Object.keys(extra);
export const mathMLAttributes = Object.fromEntries(Object.entries(extra).map(([tag, attributes]) => [tag, [...globals, ...attributes]]));
const boolean = /^(?:true|false)$/;
const lengthToken = String.raw`(?:[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:em|ex|px|rem|%|pt|pc|in|cm|mm)?|[+-]?(?:width|height|depth)|(?:negative)?(?:veryverythin|verythin|thin|medium|thick|verythick|veryverythick)mathspace|infinity|thin|medium|thick)`;
const length = new RegExp(`^${lengthToken}$`, "i"), lengths = new RegExp(`^${lengthToken}(?:\\s+${lengthToken}){0,19}$`, "i");
const colors = /^(?:#[a-f\d]{3,8}|[a-z]{1,32}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+/-]+\))$/i;
const validators: Record<string, RegExp> = {
  display: /^(?:block|inline)$/, xmlns: /^http:\/\/www\.w3\.org\/1998\/Math\/MathML$/,
  displaystyle: boolean, scriptlevel: /^[+-]?\d{1,3}$/, mathbackground: colors, mathcolor: colors,
  mathsize: new RegExp(`^(?:small|normal|big|${lengthToken})$`, "i"), dir: /^(?:ltr|rtl|auto)$/,
  mathvariant: /^[a-z-]{1,40}$/, form: /^(?:prefix|infix|postfix)$/,
  fence: boolean, separator: boolean, stretchy: boolean, symmetric: boolean, largeop: boolean, movablelimits: boolean, accent: boolean, accentunder: boolean,
  width: length, height: length, depth: length, lspace: length, rspace: length, voffset: length, maxsize: length, minsize: length, linethickness: length,
  columnalign: /^(?:left|center|right)(?:\s+(?:left|center|right)){0,99}$/,
  rowalign: /^(?:top|bottom|center|baseline|axis)(?:\s+(?:top|bottom|center|baseline|axis)){0,99}$/,
  align: /^(?:top|bottom|center|baseline|axis)(?:\s+[+-]?\d{1,4})?$/,
  rowspacing: lengths, columnspacing: lengths, framespacing: lengths,
  columnlines: /^(?:none|solid|dashed)(?:\s+(?:none|solid|dashed)){0,99}$/, rowlines: /^(?:none|solid|dashed)(?:\s+(?:none|solid|dashed)){0,99}$/, frame: /^(?:none|solid|dashed)$/,
  columnspan: /^(?:[1-9]\d{0,2}|1000)$/, rowspan: /^(?:[1-9]\d{0,2}|1000)$/,
  encoding: /^application\/x-tex$/, notation: /^[a-z]+(?: [a-z]+){0,19}$/,
};
export const mathMLTransforms = Object.fromEntries(mathMLTags.map(tag => [tag, (_name: string, original: Record<string, string>) => {
  const attribs = { ...original };
  for (const attribute of mathMLAttributes[tag]) if (attribute in attribs && (attribs[attribute].length > 1000 || !validators[attribute]?.test(attribs[attribute]))) delete attribs[attribute];
  return { tagName: tag, attribs };
}]));
