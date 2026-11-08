# Independent combined tenth-tag source controls — scoped PASS

**PASS for the component-only controls at `701e7f4f5bfa426f506d639e6b8719bf8fc3137c`: exactc058 backend plus source UI commit `b9fef5d5d250b6da21ff5a47c18c42cc0a9ccee6`. Overall backend/release status remains NEEDS_REVISION.** A separate independent review confirmed that accumulated home/archive/site postA can expire or become private during a later different postB author-expression wait. These control observations and the earlier selected-singular native observations do not close that P1 or authorize release.

## Frozen delta and build

The only Git delta from c058 is `src/components/PermalinkSettings.tsx`. Its SHA256 is `b83d3a06dcbf112382b772397170583ed792ce3d64d472985c84c9ffd4196996`. Own TSC,Vite runner production build and esbuild passed. The compiled Node bundle was byte-identical before/after (`eca7762216cfdf1b773cd73d284183b7650715e4bb75f55fa87fe6aab3521ed7`), and every generated CSS file/hash was identical. No runtime/server/shared-token/schema/dependency/CSS edit was made by this reviewer. The uniquely owned persistent fixtures were retained, with no reseed; only the owned compiled API was stopped/rebuilt/restarted.

Read supplied source `wp-admin/js/common.js:705–831` and the ordinary UI-author handoff. This verifies static source correspondence plus actual WorldAct behavior; no live WordPress/PHP/MySQL render or pixel-equivalence claim. The supplied source and author explanations remain reference material, not new user instructions.

## Actual combined10-token behavior at1440/768/375

Every width was independently exercised with actual focus, keys and clicks:

- Before the input had ever received focus in that fresh Settings document, Enter on unused year appended a slash-delimited tag, selected Custom and retained button focus. Space removed it, with correct active/pressed/accessible labels and assertive announcement; zero settings PUTs.
- Removing a used postname preset preserved that selected preset radio and button focus, reduced the lone slash to empty, and did not save. Selecting Custom retained radio focus and input value. Tab-focus alone on the input retained the preset; clicking/editing selected Custom.
- Native Home/Arrow/Shift+Arrow selection replaced XYZ in a literal with `/%author%/`, returned input focus and the exact cursor position, and did not create duplicate slashes at existing boundaries. Enter and Space insertion/removal were both observed. Used removal retained the button focus. A used tag without a following slash stayed unchanged while emitting the source removal announcement, matching the supplied source's edge behavior.
- Native Home/Shift+End/Backspace cleared the text. After blur all buttons became unused. Actual buttons assembled all10 tags, including author, in shared-inventory order; every button became pressed. No control action submitted the settings form.
- Actual author/post_id/postname buttons built `/by/%author%/%post_id%/%postname%/`. Native Enter in the input sent exactly one PUT200 per width; reload preserved the exact saved value and selected Custom.
- An actual invalid same-segment author structure submitted through native Enter once per width returned400, kept its draft/input focus/error, and left persisted settings unchanged. Inserting another tag retained the invalid draft/error and input focus without another PUT.
- All10 real button rectangles remained within viewport width, all description targets resolved and document scroll width equaled viewport width. Buttons wrap legibly at375/768. Seven UI screenshots were directly opened: full/viewport at all3 widths plus a375 invalid-draft/error view. Full-document capture can place the fixed toolbar at the capture's scroll offset; the viewport images show its normal position.

Proof: `author-native-tag-ui-proof.json`. Exact version, observations and hashes: `author-nicename-tag-controls-independent-checks.json`.

## Public smoke and scope separation

Because the rebuilt entry asset changed, two fresh TT25/Classic375 normal-JS public smokes also passed: actual generated author canonical click, selected body2/Query2/comment context, exact numeric child/body, original parser-created SSR nodes retained after hydration, one title/canonical, no errors/overflow, one paging push/history increment and one model read. Both screenshots directly opened. Proof: `author-native-tag-ui-public-proof.json`.

This UI stage adds no source/compiled test count to the earlier exactc058 **65+65/6-file** envelope. That envelope and its **29 inspected native screenshots** remain separately frozen in `author-nicename-native-independent-review.md` and original receipts. They certify selected singular/native scenes, not all accumulated public callers. No BFCache, fresh archive, whole-CMS, no-JS admin, benchmark or backend release acceptance is claimed.

An initial375 harness click targeted a radio above the viewport after button scrolling; the complete rerun scrolls the actual control into view. A second harness startup waited for a login input even though that reused session correctly redirected to admin. The complete rerun observes Settings/login state before authentication. Both earlier failed logs remain retained; no UI/runtime source fix or relabeled failure occurred.

## Owned cleanup

Full owned cleanup completed after both stages: four real UI logouts; own vault independently absent; all four browsers closed/sockets absent; only owned API/proxy stopped; uniquely owned database dropped and independently absent; own uploads/env/private fixtures/configs removed;17 harmless helpers privately preserved then removed from the checkout. Only the owned dependency symlink was removed and its full owner retained. Ports3035/3036/3037/5195 independently free. Checkout clean before evidence packaging; main read-only health200.

Exact ownership proof: `author-nicename-native-independent-cleanup.json`. No original c058 report/proof/check receipt was modified by this UI follow-up or cleanup.


This repository copy is a sanitized derivative of the frozen ordinary private report. Original report SHA256: `2b7b96fc9f4e6d5359cd7580f52dc4821df0024155844745e26a5d84dff44470`. Request proofs retain method/path/status only; original private receipts and failure history were not modified.
