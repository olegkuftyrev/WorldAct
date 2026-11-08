import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@wordpress/block-library/build-style/style.css";
import "@wordpress/block-library/build-style/theme.css";
import "./screens/public.css";
import "./styles.css";
import PublicApplication from "./public/PublicApplication";
import { errorText } from "./components/PublicPrimitives";
import { ApplicationDocumentRequired, gatePublicRoot, installPublicLifecycle, isFrameworkPath, loadPublicDocument, publicPath, validPublicModel } from "./public/publicOwnership";
import type { PublicDocumentModel } from "../shared/public-document";

installPublicLifecycle();
if(!document.title)document.title="WorldAct";
const root=document.getElementById("root")!;
const payload=document.getElementById("worldact-public-document");
let initial:PublicDocumentModel|null=null;
if(payload){try{const value:unknown=JSON.parse(payload.textContent || "");if(validPublicModel(value,publicPath()))initial=value;}catch{}payload.remove();}
let mounted=false,request=0,abort:AbortController|null=null;
async function boot(){
 const current=++request;abort?.abort();abort=new AbortController();
 const path=publicPath(),generation=window.__worldactPublicLifecycle!.generation;
 if(isFrameworkPath(path)){root.replaceChildren();mounted=true;ReactDOM.createRoot(root).render(tree(null));return;}
 gatePublicRoot();
 try{
  const fresh=await loadPublicDocument(path,abort.signal);
  if(current!==request || generation!==window.__worldactPublicLifecycle!.generation || path!==publicPath())return;
  const matches=initial && JSON.stringify(initial)===JSON.stringify(fresh);initial=null;mounted=true;
  if(matches)ReactDOM.hydrateRoot(root,tree(fresh),{identifierPrefix:"worldact-public-"});
  else{root.replaceChildren();ReactDOM.createRoot(root).render(tree(fresh));}
 }catch(error){if(current!==request || abort.signal.aborted)return;initial=null;root.replaceChildren();mounted=true;ReactDOM.createRoot(root).render(error instanceof ApplicationDocumentRequired ? tree(null,"",true):tree(null,errorText(error)));}
}
function tree(model:PublicDocumentModel|null,error="",applicationDocument=false){return <React.StrictMode><BrowserRouter><PublicApplication initialModel={model} initialError={error} applicationDocument={applicationDocument}/></BrowserRouter></React.StrictMode>;}
window.addEventListener("worldact-public-retire",()=>{if(!mounted){request++;abort?.abort();}});
window.addEventListener("worldact-public-restore",()=>{if(!mounted)void boot();});
void boot();
