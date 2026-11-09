# Source permalink tag controls

Code: `b9fef5d5d250b6da21ff5a47c18c42cc0a9ccee6`, based on `4731fa5a09e0a12ad538e1b9b56e096f773b30ad`. This is a component-only source port in `src/components/PermalinkSettings.tsx`. Existing copied WordPress form/button styles supply the layout; no CSS, server, schema, shared token inventory, or test contracts changed.

## Source correspondence

The supplied WordPress tree declares version **7.1.4** in `wp-includes/version.php:19`. This label describes the supplied files; it is not an assertion about an upstream release. No PHP/MySQL process or live WordPress render was used.

- `wp-admin/options-permalink.php:281–401`: token explanations, hidden input label, native field/radio names and relationships, available-tag fieldset/list/buttons, active-tag labels, and assertive live-region copy.
- `wp-admin/js/common.js:705–831`: preset updates; custom selection on input click/input; first-focus tracking; used-tag state; selection-aware insertion and conditional slashes; focus/cursor return only after previous input focus; used-tag removal. The supplied tree has no separate `options-permalink.js`; its behavior is in this `common.js` section.
- `wp-admin/css/forms.css:1260–1294,1829–1841`: existing tag flex wrapping and responsive permalink fields, already copied into WorldAct.

The native source's edge behavior is retained: removing a used tag removes its first `tag/` occurrence, preserves the current preset radio and button focus, and converts a lone `/` to an empty value. A token without a following slash remains unchanged even though the source removal announcement fires. Selecting the Custom Structure radio keeps focus on that radio. Focusing the text input by Tab alone does not change the selected radio; clicking or editing it does.

The shared supported-token inventory produces all nine current buttons in inventory order. The source explanation for `author` is present, but no tenth button is exposed until that token is enabled by the separate backend change. This batch does not certify that unreleased integration.

## Verification

TypeScript, Vite production client build (`--configLoader runner`), and compiled server bundle passed on the frozen component. Existing guarded `platform`, `plain-permalinks`, and `permalink-time-tokens` suites passed **42 source checks and 42 compiled checks across three files per mode**, with zero failures or skips. These are selected regression gates, not a whole-repository certification.

`native-proof.json` records twelve initial native checkpoints and independent repeat rows at **1440, 768, and 375 pixels**. Real browser keys cover selection replacement, Enter insertion, Space insertion/removal, cursor placement, custom-radio focus, and Home/Shift+End/Backspace deletion. Button actions produce zero unintended settings PUTs. All nine tags were assembled with actual buttons, saved once through the existing form (HTTP 200), and reloaded with the exact saved structure. A real unsupported-token save returns HTTP 400 while preserving the draft and text focus; inserting another tag retains that draft/error and sends no further PUT.

All three widths have no document overflow, all nine buttons remain within the viewport width, and every `aria-describedby` target resolves. Seven screenshots were directly opened during author QA. All seven screenshots are included here. Full-document screenshots can place a fixed toolbar at its capture scroll offset; the viewport screenshots show its normal position.

This evidence establishes static source correspondence and native behavior in WorldAct, without claiming live WordPress pixel equality, whole-CMS parity, or an independent post-integration review. The React admin screen still requires JavaScript. Source-shaped button state uses explicit `aria-pressed=false` for unused tags; the source leaves that attribute absent for an unused tag until it has previously been used and removed.

## Cleanup

The uniquely owned database, uploads, environment file, credential record, browser session, vault entry, and dependency symlink were removed. Ports 3044, 3050, and 3051 were verified free. The shared dependency owner was retained, and the existing main API still returned HTTP 200. No main environment, application data, dependency tree, or service was changed.
