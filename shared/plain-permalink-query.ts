export type PlainPermalinkQuery =
  | { kind: "none" | "invalid" }
  | { kind: "post" | "page"; id: number; contentPage?: number };

/** Fixed public identity keys; malformed/duplicate identities must not silently
 * become the home page. Shared with the React root-route adapter. */
export function readPlainPermalinkQuery(query: URLSearchParams): PlainPermalinkQuery {
  const shaped=[...query.keys()].filter(key=>/^(p|page_id)(?:\[|$)/.test(key));
  if(!shaped.length)return {kind:"none"};
  if(shaped.length!==1||!["p","page_id"].includes(shaped[0]))return {kind:"invalid"};
  const key=shaped[0],value=query.get(key)!;
  const valid=(input:string)=>/^[1-9]\d{0,9}$/.test(input)&&Number(input)<=2147483647;
  if(!valid(value))return {kind:"invalid"};
  if([...query.keys()].some(key=>/^page\[/.test(key)))return {kind:"invalid"};
  const pages=query.getAll("page");
  if(pages.length>1||(pages.length&&!valid(pages[0])))return {kind:"invalid"};
  return {kind:key==="p"?"post":"page",id:Number(value),...(pages.length?{contentPage:Number(pages[0])}:{})};
}
