import { createReduxStore, register, dispatch } from "@wordpress/data";

type Preview = {id?:number|string;type?:string;templateId?:string|null;attributes?:Record<string,unknown>};
// Some official block hooks read these selectors even when explicit block
// context is supplied. This bridge exposes preview context, never save actions.
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
export function setEditorPreview(owner:symbol,value:Preview) {
  owners.set(owner,value);
  void dispatch(store).setPreview([...owners.values()].at(-1) || {});
}
export function removeEditorPreview(owner:symbol) {
  owners.delete(owner);
  void dispatch(store).setPreview([...owners.values()].at(-1) || {});
}
