import test from "./isolated-test.js";
import assert from "node:assert/strict";
import {select} from "@wordpress/data";
import {setEditorPreview,removeEditorPreview,activateEditorPreview} from "../src/editor/editorPreviewStore.js";

test("returning from nested editing restores the outer identity before outer native effects run",()=>{
  const parent=Symbol("parent"),child=Symbol("child"),grandchild=Symbol("grandchild");
  const current=()=>select("core/editor").getCurrentPostId();
  try{
    setEditorPreview(parent,{id:"theme//template",type:"wp_template"});
    setEditorPreview(child,{id:"theme//overlay",type:"wp_template_part",attributes:{area:"navigation-overlay"}});
    setEditorPreview(grandchild,{id:7,type:"wp_block"});
    assert.equal(current(),7);
    setEditorPreview(parent,{id:"theme//template",type:"wp_template",attributes:{title:"Updated parent"}});
    assert.equal(current(),7,"a background metadata update cannot activate an outer editor");
    activateEditorPreview(child);assert.equal(current(),"theme//overlay");
    removeEditorPreview(grandchild);assert.equal(current(),"theme//overlay");
    activateEditorPreview(parent);assert.equal(current(),"theme//template");
    setEditorPreview(child,{id:"theme//overlay",type:"wp_template_part",attributes:{area:"navigation-overlay"}});
    assert.equal(current(),"theme//template","late nested metadata cannot reactivate a closed editor");
    removeEditorPreview(child);assert.equal(current(),"theme//template");
  }finally{removeEditorPreview(grandchild);removeEditorPreview(child);removeEditorPreview(parent);}
  assert.equal(current(),null);
});
