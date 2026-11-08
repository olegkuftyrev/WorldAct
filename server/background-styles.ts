// Fixed CSS grammar: image URLs never contain CSS escapes, quotes or functions.
const url = String.raw`(?:https?:\/\/|\/(?!\/))[A-Za-z0-9\-._~:/?#\[\]@!$&*+,=%]{0,4096}`;
const image = `url\\(\\s*(?:"${url}"|'${url}'|${url})\\s*\\)`;
const gradient = String.raw`(?:linear-gradient|radial-gradient|conic-gradient)\((?:[^()"'<>\\;@:\u0000-\u001f]|(?:rgba?|hsla?|var)\([^()"'<>\\;@:\u0000-\u001f]*\))*\)`;
const preset = String.raw`var\(--wp--preset--gradient--[a-z0-9-]+\)`;
const layer = `(?:${image}|${gradient}|${preset})`;
const singleLayerPattern = new RegExp(`^(?=.{1,8000}$)${layer}$`, "i");
const gradientLayerPattern = new RegExp(`^(?=.{1,8000}$)(?:${gradient}|${preset})$`, "i");
export const backgroundImagePattern = new RegExp(`^(?=.{1,16000}$)(?:none|${layer}(?:\\s*,\\s*${layer})?)$`, "i");
export const backgroundSizePattern = /^(?:cover|contain|auto|(?:auto|\d+(?:\.\d+)?(?:px|em|rem|%|vw|vh|ch|ex))(?:\s+(?:auto|\d+(?:\.\d+)?(?:px|em|rem|%|vw|vh|ch|ex)))?)$/i;
export const backgroundPositionPattern = /^(?:(?:left|right|top|bottom|center|-?\d+(?:\.\d+)?(?:px|em|rem|%|vw|vh|ch|ex)?)(?:\s+(?:left|right|top|bottom|center|-?\d+(?:\.\d+)?(?:px|em|rem|%|vw|vh|ch|ex)?)){0,3})$/i;
export const backgroundRepeatPattern = /^(?:repeat|no-repeat|repeat-x|repeat-y|space|round)(?:\s+(?:repeat|no-repeat|space|round))?$/i;
export const backgroundAttachmentPattern = /^(?:scroll|fixed|local)$/i;

/** Rendering an image URL is a browser operation; this never fetches a URL. */
export function safeBackgroundURL(value: unknown): string {
  if(typeof value!=="string" || value.length>4096 || /[\\\u0000-\u001f\u007f]/.test(value))return "";
  const input=value.trim();
  if(!/^(?:https?:\/\/|\/(?!\/))/i.test(input))return "";
  try{
    const parsed=new URL(input,"http://worldact.invalid");
    if(!["http:","https:"].includes(parsed.protocol) || parsed.username || parsed.password)return "";
    const result=(input.startsWith("/")?parsed.pathname+parsed.search+parsed.hash:parsed.href)
      .replace(/["'()<>;\s]/g,character=>encodeURIComponent(character).replace(/[!'()*]/g,letter=>"%"+letter.charCodeAt(0).toString(16).toUpperCase()));
    return result.length<=4096 && backgroundImagePattern.test(`url("${result}")`)?result:"";
  }catch{return "";}
}

/** Port of source background support, including cover and contain defaults. */
export function backgroundStyles(value: unknown): string {
  if(!value || typeof value!=="object" || Array.isArray(value))return "";
  const background=value as Record<string,any>,pairs:string[]=[],layers:string[]=[];
  const image=background.backgroundImage;
  if(image && typeof image==="object" && !Array.isArray(image)){
    const url=safeBackgroundURL(image.url);if(url)layers.push(`url("${url}")`);
  }else if(typeof image==="string" && singleLayerPattern.test(image))layers.push(image);
  const hasImage=layers.length>0;
  const gradient=typeof background.gradient==="string"?background.gradient.replace(/^var:preset\|gradient\|([a-z0-9-]+)$/i,"var(--wp--preset--gradient--$1)"):"";
  if(gradient && gradientLayerPattern.test(gradient))layers.push(gradient);
  if(layers.length)pairs.push("background-image:"+layers.join(", "));
  const size=background.backgroundSize ?? (hasImage?"cover":undefined);
  const position=background.backgroundPosition || (size==="contain" && hasImage?"50% 50%":undefined);
  for(const [property,input,pattern] of [
    ["background-size",size,backgroundSizePattern],["background-position",position,backgroundPositionPattern],
    ["background-repeat",background.backgroundRepeat,backgroundRepeatPattern],["background-attachment",background.backgroundAttachment,backgroundAttachmentPattern],
  ] as const)if(typeof input==="string" && input.length<=200 && pattern.test(input))pairs.push(property+":"+input);
  return pairs.join(";");
}
