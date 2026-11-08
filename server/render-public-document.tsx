import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { PublicDocumentModel, PublicHead } from "../shared/public-document.js";
import { PUBLIC_LIFECYCLE_SCRIPT, PUBLIC_LIFECYCLE_STYLE } from "../shared/public-lifecycle.js";
import { PublicDocumentView } from "../src/public/PublicDocumentView.js";
import { HttpError } from "./utils.js";

// Existing source fragments and complete comment windows retain their 8 MiB
// budgets. Assembly also counts repeated legitimate fragments, React markup,
// compiler assets/head and escaped bootstrap JSON; it never truncates success.
export const MAX_PUBLIC_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const PUBLIC_IDENTIFIER_PREFIX = "worldact-public-";
const markers = ["<!--worldact-public-head-->","<!--worldact-public-root-->","<!--worldact-public-data-->"] as const;
const escaped: Record<string,string> = {"<":"\\u003c",">":"\\u003e","&":"\\u0026","\u2028":"\\u2028","\u2029":"\\u2029"};
const overflow=()=>new HttpError(413,"The complete public document exceeds the 64 MiB limit. Reduce repeated content or comments per page.");
const bytes=(value:string)=>Buffer.byteLength(value,"utf8");
function assertBudget(...values:string[]) {
  let total=0;
  for(const value of values){total+=bytes(value);if(total>MAX_PUBLIC_DOCUMENT_BYTES)throw overflow();}
}
function escapeHTML(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g,character=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
}
export function serializePublicDocument(model:PublicDocumentModel):string {
  const raw=JSON.stringify(model);
  assertBudget(raw);
  // Check expansion before allocating the escaped copy. An HTML-heavy accepted
  // fragment can have many '<'/'&' characters; raw JSON length is insufficient.
  let size=bytes(raw);
  for(const match of raw.matchAll(/[<>&\u2028\u2029]/g)){
    size+=bytes(escaped[match[0]])-bytes(match[0]);if(size>MAX_PUBLIC_DOCUMENT_BYTES)throw overflow();
  }
  return raw.replace(/[<>&\u2028\u2029]/g,character=>escaped[character]);
}
export function renderPublicHead(head:PublicHead):string {
  const tag=' data-worldact-public-head=""';
  const meta=(name:string,value:string,property=false)=>`<meta${tag} ${property?"property":"name"}="${escapeHTML(name)}" content="${escapeHTML(value)}">`;
  const link=(rel:string,href:string,sizes?:string)=>`<link${tag} rel="${escapeHTML(rel)}" href="${escapeHTML(href)}"${sizes?` sizes="${escapeHTML(sizes)}"`:""}>`;
  const out=[`<title${tag}>${escapeHTML(head.title)}</title>`];
  if(head.robots)out.push(meta("robots",head.robots));
  if(head.canonical)out.push(link("canonical",head.canonical));
  if(head.seo){const seo=head.seo;out.push(meta("description",seo.description),meta("og:title",seo.title,true),meta("og:description",seo.description,true),meta("og:type",seo.type,true),meta("og:url",seo.url,true));if(seo.image)out.push(meta("og:image",seo.image,true));}
  for(const icon of head.icons)out.push(link(icon.rel,icon.href,icon.sizes));
  if(head.tileImage)out.push(meta("msapplication-TileImage",head.tileImage));
  if(head.pingback)out.push(link("pingback",head.pingback));
  return out.join("");
}
/** Trusted compiler template only. Fixed markers must occur exactly once. */
function assemble(index:string,head:string,root:string,data:string) {
  for(const marker of markers)if(index.split(marker).length!==2)throw new Error("The built document markers are missing or duplicated.");
  assertBudget(index,head,root,data);
  // Split/join replacement never interprets '$&' or other user-derived values
  // as replacement syntax and never searches already inserted user markup.
  const replacements=new Map<string,string>([[markers[0],head],[markers[1],root],[markers[2],data]]);
  const result=index.split(/(<!--worldact-public-(?:head|root|data)-->)/).map(part=>replacements.get(part) ?? part).join("");
  assertBudget(result);
  return result;
}
export function renderFrameworkDocument(index:string) {
  return assemble(index,'<title data-worldact-default-head="">WorldAct</title><meta data-worldact-default-head="" name="description" content="WorldAct — a personal publishing platform.">',"","");
}
export function renderPublicDocument(index:string,model:PublicDocumentModel) {
  const json=serializePublicDocument(model);
  const root=renderToString(createElement(PublicDocumentView,{model}),{identifierPrefix:PUBLIC_IDENTIFIER_PREFIX});
  const head=renderPublicHead(model.head)+`<style data-worldact-public-gate="">${PUBLIC_LIFECYCLE_STYLE}</style><script>${PUBLIC_LIFECYCLE_SCRIPT}</script>`;
  const data=`<script id="worldact-public-document" type="application/json">${json}</script>`;
  return assemble(index,head,root,data);
}
