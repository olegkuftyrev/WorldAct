# Public document server rendering

The public document path has a direct data service, a narrow shared React view,
and a compiler-index assembler. It never renders App or forwards internal HTTP.
Administrative/editor code remains outside the shared view import graph.

- `shared/public-document.ts` defines presentation-only model types and a minimal
  viewer. `shared/public-routing.ts` normalizes supported scalar query values
  before flattening, retains date aliases and selects exact template priority.
- `public-documents.ts` resolves body-free metadata. `public-read.ts` contains
  existing public post/site/comment read operations, including a separate body
  acquisition fenced to selected immutable ID/type/current publication.
- `public-document-data.ts` combines safe data, current request-only grants,
  precomputed source HTML/Classic slots, deterministic dates/open-state/native
  Reply context and safe head. The browser route loader is
  GET `/api/public/document?path=...`; a missing public route returns a typed404
  model. Framework destinations return400 with `kind:"framework"` and error.
- `src/public/PublicDocumentView.tsx` renders source HTML as an opaque island and
  Classic through the extracted existing JSX. It needs no Router, DOMParser,
  editor or browser enhancer. `PublicDocumentView({model})` has deterministic
  initial interaction state; `worldact-public-` is the shared React identifier
  prefix. Native Classic password/comment/logout/search/paging controls have
  actual endpoint/form/link semantics.
- `render-public-document.tsx` uses ReactDOMServer and exactly three trusted
  compiler markers, once each: public-head, public-root, public-data. Framework
  shell requests fill only the default head. Public requests receive actual
  owned head metadata, the view and one inert #worldact-public-document script.
  The fixed lifecycle constants are emitted in the head before body parsing.
- `index.ts` reads cookie-only identity, obtains one model, renders fully and
  then commits HTML status/headers. Static/assets/APIs/native forms/legacy routes
  retain their earlier handlers. No body is globally cached.

Runtime settings/posts are explicitly projected into the model. Navigation page
objects contain no duplicate bodies; the selected model.post is authoritative.
Source templates and Classic slots contain rendered public HTML, not raw saved
template/block data. Extension configuration uses the existing per-extension
public allowlist. No account/comment email, pending counts, hash or cookie/grant
credential is placed in the bootstrap. Browser remembered-author loading stays
separate and private. Public content sanitizers and existing block budgets still
apply before assembly.

Inert JSON serialization escapes `<`, `>`, `&`, U+2028 and U+2029. Its expansion
is counted before allocating the escaped copy. Title/meta/link attributes are
HTML escaped; the React style element protects its raw-text closing boundary.
Only fixed dependency-free lifecycle code is executable; no request string is
concatenated into it. Marker replacement operates on the original trusted index
and never re-searches inserted user markup or interprets replacement `$&` text.
The64MiB assembly budget includes escaped bootstrap, rendered React/head and
compiler template. It accommodates repeated legitimate fragments while keeping
a finite document-level bound beyond each existing8MiB renderer/window budget.
It does not raise those lower budgets or silently truncate content. Missing or
duplicated compiler markers fail closed through the generic500 handler.

The fixed early script gates the entire root for JavaScript-enabled documents,
including anonymous openings, until the browser controller performs one fresh
owned document revalidation. Root composited opacity plus visibility and pointer
suppression cannot be defeated by descendant visibility; an early observer sets
the parsed root inert. Layout is retained. Pagehide increments ownership and
gates immediately; persisted pageshow asks the controller to revalidate before
exposure. Script/boot/revalidation failures keep the root suppressed and expose
a fixed safe retry outside it. No-JavaScript requests receive their authorized
request-time HTML normally. Already delivered no-JavaScript bytes cannot be
retroactively revoked. Actual independent browser review exercised held HTML across logout, account
changes, grants and publication changes, plus real pagehide and Back/Forward.
This browser reported persisted:false and refused BFCache admission because of
no-store resources and browsing-instance policy. Genuine BFCache restoration
is therefore not certified; no synthetic persisted event substitutes for it.

The browser controller adopts tagged head/gate nodes, consumes and removes the
bootstrap once, uses the shared view/prefix and retires stale route/account
owners before exposing fresh data. It preserves source form-local errors,
Reply drafts/focus/counters, native actions and scoped enhancer cleanup. Actual
missing built JS and CSS leave a visible, keyboard-reachable outside-root retry.
A model failure clears the old tree and offers fresh recovery. See
[browser ownership](../src/public/README.md) and the [author evidence with exact
stage hashes and preserved failures](../docs/evidence/public-ssr/README.md).

Native comment/password forms include an optional local return target. The
server validates current public immutable post identity/type and recognized
query fields; invalid explicit targets never borrow a Referer. Approved comment
returns select the actual chronological page containing the saved root/reply,
including explicit page1 when newest is the default. Pending returns preserve
valid context without exposing the pending body. Password returns preserve only
positive Reply intent for fresh eligibility validation. Body-page and block-query
counters remain independent. The endpoints still use the existing actual
submission/unlock policies before calculating a303; JSON mutations are unchanged.

The final runtime at207 (fixture-only successor f2) passed the full local source
and actual compiled CI selector, fresh Plain archive restore, clean install and
separate independent backend/native review. See the [verification record](../docs/evidence/public-ssr/integrated-review.md) for exact counts and remaining bounds.
Standalone React login/admin/editor remain JavaScript shells. This records a
reviewed public-document scope, not complete WordPress equivalence.
