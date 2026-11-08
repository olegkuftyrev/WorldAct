import { createReduxStore, register, dispatch } from "@wordpress/data";

type Preview = {id?:number|string;type?:string;templateId?:string|null;attributes?:Record<string,unknown>};
// Official block hooks read the editing entity through these selectors. Block
// previews have separate explicit context; this bridge never exposes saves.
const store=createReduxStore("core/editor",{
  reducer:(state:Preview={},action:{type:string;value?:Preview})=>action.type==="WORLDACT_PREVIEW"?action.value || {}:state,
  actions:{setPreview:(value:Preview)=>({type:"WORLDACT_PREVIEW",value})},
  selectors:{
    getCurrentPostId:(state:Preview)=>state.id ?? null,
    getCurrentPostType:(state:Preview)=>state.type ?? null,
    getCurrentTemplateId:(state:Preview)=>state.templateId ?? null,
    getEditedPostAttribute:(state:Preview,name:string)=>name==="type"?state.type:state.attributes?.[name],
  },
});
register(store);
const owners=new Map<symbol,Preview>();
let activeOwner:symbol|undefined;
const publish=()=>void dispatch(store).setPreview(activeOwner?owners.get(activeOwner) || {}:{});
export function setEditorPreview(owner:symbol,value:Preview) {
  if(!owners.has(owner))activeOwner=owner;
  owners.set(owner,value);
  publish();
}
export function removeEditorPreview(owner:symbol) {
  owners.delete(owner);
  if(activeOwner===owner)activeOwner=[...owners.keys()].at(-1);
  publish();
}
/** Restore the outer identity before its native blocks are mounted again. */
export function activateEditorPreview(owner:symbol) {
  if(owners.has(owner)){activeOwner=owner;publish();}
}
