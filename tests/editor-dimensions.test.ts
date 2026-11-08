import test from "./isolated-test.js";
import assert from "node:assert/strict";
import {editorDimensionSettings} from "../src/editor/backgroundSettings.js";

test("native width controls follow source appearanceTools opt-ins and preserve explicit theme disables",()=>{
  assert.deepEqual(editorDimensionSettings({appearanceTools:true}),{aspectRatio:true,height:true,minHeight:true,minWidth:true,width:true});
  assert.equal(editorDimensionSettings({appearanceTools:true,dimensions:{width:false}}).width,false);
  assert.deepEqual(editorDimensionSettings({appearanceTools:false}),{});
  assert.deepEqual(editorDimensionSettings({appearanceTools:false,dimensions:{width:true}}),{width:true});
});
