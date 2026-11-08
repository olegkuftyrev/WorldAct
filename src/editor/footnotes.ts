import type { Footnote } from "../api";

type FootnoteBlock = { attributes: Record<string, unknown>; innerBlocks: FootnoteBlock[] };
type RichTextAdapter = { read: (value: unknown) => string | null; write: (html: string) => unknown };
const validId = /^[a-z0-9_-]{1,100}$/;
const bytes = (value: unknown) => new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;

export function readFootnotes(value: unknown): Footnote[] {
  if (typeof value === "string") {try {value = JSON.parse(value);} catch {return [];}}
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const notes = value.filter((note): note is Footnote => !!note && typeof note.id === "string" && validId.test(note.id) && typeof note.content === "string" && !seen.has(note.id) && !!seen.add(note.id)).map(({id,content})=>({id,content}));
  if (notes.length > 500 || notes.some((note)=>bytes(note.content)>20_000) || bytes(notes)>1_000_000) throw new Error("Footnotes exceed the supported limit of 500 notes, 20 KB per note, or 1 MB in total.");
  return notes;
}

/** Per-document bounded counterpart of core-data's deleted-footnote cache. */
export function rememberFootnotes(cache: Map<string, Footnote>, notes: Footnote[]) {
  for (const note of notes) {cache.delete(note.id);cache.set(note.id,note);}
  let cacheBytes=[...cache.values()].reduce((sum,note)=>sum+bytes(note),0);
  while (cache.size > 1000 || cacheBytes > 1_000_000) {const id=cache.keys().next().value!;cacheBytes-=bytes(cache.get(id));cache.delete(id);}
}

/**
 * Port of useEntityBlockEditor's footnote ordering/numbering for our controlled
 * provider. Serialized block HTML supplies actual document order, including
 * nested blocks. Metadata and blocks are returned as one history transaction.
 */
export function synchronizeFootnotes<T extends FootnoteBlock>(blocks: T[], serializedHTML: string, current: Footnote[], deleted: Map<string, Footnote>, parseHTML: (html: string) => Document, richText?: RichTextAdapter): {blocks:T[];footnotes:Footnote[]} {
  const order: string[] = [], seen = new Set<string>();
  for (const reference of parseHTML(serializedHTML).querySelectorAll("sup[data-fn]")) {
    const id=reference.getAttribute("data-fn") || "";
    if(validId.test(id) && !seen.has(id)) {order.push(id);seen.add(id);}
  }
  if(order.length>500)throw new Error("A document can contain up to 500 footnotes.");
  const existing=new Map(readFootnotes(current).map(note=>[note.id,note]));
  const notes=readFootnotes(order.map(id=>existing.get(id)||deleted.get(id)||{id,content:""}));
  rememberFootnotes(deleted,current.filter(note=>!seen.has(note.id)));
  const index=new Map(order.map((id,position)=>[id,String(position+1)]));
  const rewriteHTML=(html:string)=>{
    if(!html.includes("data-fn"))return html;
    const document=parseHTML(html);let changed=false;
    for(const reference of document.querySelectorAll("sup[data-fn]")) {
      const number=index.get(reference.getAttribute("data-fn") || "");
      const label=reference.querySelector("a") || reference;
      if(number && label.textContent!==number){label.textContent=number;changed=true;}
    }
    return changed?document.body.innerHTML:html;
  };
  const rewrite=(value:unknown,depth=0):unknown=>{
    if(depth>20)return value;
    if(typeof value==="string")return rewriteHTML(value);
    const richHTML=richText?.read(value);
    if(richHTML!==undefined && richHTML!==null){const next=rewriteHTML(richHTML);return next===richHTML?value:richText!.write(next);}
    if(Array.isArray(value)){const next=value.map(item=>rewrite(item,depth+1));return next.some((item,i)=>item!==value[i])?next:value;}
    if(value && typeof value==="object"){const entries=Object.entries(value),next=entries.map(([key,item])=>[key,rewrite(item,depth+1)] as const);return next.some(([,item],i)=>item!==entries[i][1])?Object.fromEntries(next):value;}
    return value;
  };
  const visit=(items:FootnoteBlock[]):FootnoteBlock[]=>items.map(block=>{
    const attributes=rewrite(block.attributes) as Record<string,unknown>, innerBlocks=visit(block.innerBlocks||[]);
    return attributes===block.attributes && innerBlocks.every((item,i)=>item===block.innerBlocks[i])?block:{...block,attributes,innerBlocks};
  });
  return {blocks:visit(blocks) as T[],footnotes:notes};
}
