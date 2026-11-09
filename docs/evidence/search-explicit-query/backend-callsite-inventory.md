# Explicit Search fields — backend callsite and boundary inventory

Frozen runtimecabaf3e1d430242433f0b0e54f5e1aa37a98dd75, corrected test-only candidate5a819ef4a68b3dcd8f9c2ea0e033d690f34d029a; Node SHAaf2177df906780e5c6f65554a1181d606cd337789d3cfa9d9bb8d87ffaf5fc33. Two runtime files only; no authored src/shared/CSS, SQL, await, observation/fence, schema, import/seed or MAIN changes.

## New pure helper

server/search-query-fields.ts owns searchQueryFieldParts(query,remainingBytes,surroundingBytes). It reads only own enumerable DATA descriptors from the block's already canonical JSON object/array. Strings, finite numbers, true1, false/null empty and nestedArray conversion are explicit; invalid scalar containers produce no fields. It neither mutates/merges the source object nor calls arbitrary getters/toString or assigns names into an authority/prototype map. Existing JSONB canonical key order is retained; PHP arbitrary numeric/key/invalid-byte parity is bounded.

Its fixed252-name Set is exactly the supplied KSES names minusapos. referenceAt scans original semicolon/case-sensitive HTML401 references with bounded significant decimal/hex digits and index-only leading zeros. It distinguishes matching-invalid hex lowercase-x/captured-zeros from unmatched all-zero spelling. escapedBytes is the shared count/emission transducer; no HTML5 decoder or recursive generated-output interpretation is used. Raw ampersands/angle brackets/bothquotes are escaped locally. Actual HTTP assertions inspect one HTML parse and submitted control pairs; source inferences are not PHP execution.

The builder first reserves actual form surroundings and each hidden input's fixed ASCII punctuation, then scans escaped name/value UTF8 lengths against remaining allowance. It retains only references/short scalar values and entry metadata before the WHOLE form fits. Only afterward does a second identical token walk emit bounded8192-code-unit chunks. No field truncation/cap, whole rejected escaped value, per-character output array or premature hidden join is created. The helper never mutates outputBytes.

## Only integration

server/theme-blocks.ts core/search retains existing id/label/button/style/classes, root action, GET, required visible s and ambient visible search value. It splits existing form at the visible-input/button boundary, measures prefix and suffix separately, invokes the helper with MAX_RENDER_BYTES-state.outputBytes, then performs one final form join. Hidden controls exist only for ownattrs.query, including no-button forms. No ambient listing/path/counter filter is inherited. Literal action/method/submit/formaction names remain inputs; no enhanced browser submission is introduced.

## Existing boundaries left unchanged

server/block-renderer.ts render() remains the single final generated-output charge, subtracting already-charged descendants. Serial renderChildren/post-template/reusable expansion uses shared State; reusable caching does not reset allowance. MAX_RENDER_BYTES8MiB, node4000, query512 and depth policy remain. Its direct service entry points, named author observations, post/body reads and public completion collector are unchanged. The new helper does not await or reach a database. Complete output accounting precedes existing final sanitation/outer document envelope, with no new full-response-size claim.

server/utils.ts cleanBlocks/cleanRawContent and cleanContent are unchanged: saved nested query JSON retains existing object/array/coercion input limits, prototype/handler filtering, URL-looking-key validation and HTML-like value sanitation. Generated input name/value attributes are already allowed; final sanitization may canonicalize equivalent entity spelling. Generic esc is unchanged everywhere, including the rest of Search markup.

server/block-render-attributes.ts and the existing preview route remain unchanged: query object required, arrays/null/scalars rejected400,100000-byte/25000-value/depth25 input budget including discarded prototype values. Saved query-array acceptance does not widen preview normalization.

Public request parsing, DTOs, path/archive identity selection, duplicate/nested recognized-parameter400, ordinary later-page404, protected search and author-before-final-post/password/token fence are unchanged. Unknown explicit names are transported, never newly supported query features. The unchanged6643 gate verifies late current grant behavior as a separate actual HTTP control.

## Evidence surfaces and provenance

Corrected frozen tests/search-explicit-query-original.test.ts is byte-identical42352 to the private reviewed adapterf89. Originalb4a/ba1 remains private and in historical commits. The adapter changes only JSON expected ordering from canonical SAVED keys with complete manual value/name tables and moves repeated-page publication after actual single GET/HEAD; raw order, duplicates, manual entity/scalar values, statuses and all29 dispatch groups remain.

Original beforeb4a onb8010/6 each mode, first cab/b4a after1/5 each and corrected before42352 onb8010/6 each are distinct certificates. The first after's JSON ordering and unrelated published over-budget PAGE context are fixture mismatches, not runtime fixes. Corrected after6each plus disjoint five affected files25each give31 scoped passes per mode. No whole broad/fresh/fixed/native/release claim is made. Actual Search/native-style GET/HEAD/model/template/preview and6643 HTTP target actual compiled Node in compiled mode; direct imported helpers/services in affected files remain TypeScript.

All six owned receipts and raw-log hashes are recorded. Own six DBs/sessions and never-created anchor are absent;3046/47/48 physically free,3062unused. New env and exact dependency link were removed; shared owner remains intact. Original/corrected probes, all failures/builds/logs, old failed5bed and conditional02b70 source archives remain retained. No raw logs, credentials, private resource paths or site exports are copied into repository evidence.
