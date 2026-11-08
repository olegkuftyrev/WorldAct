import test from "./isolated-test.js";
import assert from "node:assert/strict";
import {overlayPickerReference} from "../src/editor/navigationOverlayReference.js";

test("native overlay picker recognizes compatible active-theme IDs without rebinding foreign or malformed references",()=>{
  assert.equal(overlayPickerReference("twentytwentyfive//my-overlay","twentytwentyfive"),"my-overlay");
  assert.equal(overlayPickerReference("my-overlay","twentytwentyfive"),"my-overlay");
  assert.equal(overlayPickerReference("twentytwentyfive//missing-overlay","twentytwentyfive"),"missing-overlay","the official picker still detects missing slugs");
  for(const value of ["twentytwentyfour//my-overlay","twentytwentyfive//bad/overlay","twentytwentyfive//../overlay","//my-overlay","https://evil.invalid/overlay","twentytwentyfive//my-overlay?x=1",null,{}])
    assert.equal(overlayPickerReference(value,"twentytwentyfive"),value);
  assert.equal(overlayPickerReference("twentytwentyfive//my-overlay"),"twentytwentyfive//my-overlay","wait for actual active-theme metadata");
});
