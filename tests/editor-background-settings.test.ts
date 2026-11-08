import test from "./isolated-test.js";
import assert from "node:assert/strict";
import { editorBackgroundSettings } from "../src/editor/backgroundSettings.js";

test("source appearanceTools enables native image/size/gradient controls without overriding explicit theme choices", () => {
  assert.deepEqual(editorBackgroundSettings({ appearanceTools: true }), { backgroundImage: true, backgroundSize: true, gradient: true });
  assert.deepEqual(editorBackgroundSettings({ appearanceTools: true, background: { backgroundImage: false, backgroundSize: false, gradient: false } }), { backgroundImage: false, backgroundSize: false, gradient: false });
  assert.deepEqual(editorBackgroundSettings({ appearanceTools: false }), {});
  assert.deepEqual(editorBackgroundSettings({ appearanceTools: false, background: { backgroundImage: true } }), { backgroundImage: true });
});
