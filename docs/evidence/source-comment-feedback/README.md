# Source comment rejection feedback

Author evidence for code commit `1d98417e7ef1a3b8e663f4adced2f933cabadf06`, based on integrated candidate `78f912046769130bd2932ea52d13ded124bb76cc`. Independent successor review is still required.

The source comment form now places its single rejection alert inside the form that was submitted. It uses the existing notice class and scrolls only enough to expose the alert. The patch leaves source request ownership, Classic, server admission, CSS, entered fields and reply parent behavior unchanged.

The actual production browser build and compiled Node API were exercised using a disposable subscriber and a long persisted source post at 1440, 768 and 375 pixels. Each case submitted an actual eligible Reply, then a distinct second Reply inside the flood interval. The second request returned 429, inserted no comment, kept the focused enabled submit control, draft, eligible parent, body page 2, Query Loop 4 page 2, and comment page 2. Exactly one alert with the real server message was visible inside the submitted form. Aging only that case's own preceding admission allowed one successful retry with the actual parent and subscriber ID. The alert then disappeared. No browser errors or horizontal overflow occurred. All three screenshots were inspected directly.

Final focused guarded checks passed: source 12 tests / 6 files, compiled 12 tests / 6 files, zero failures/skips; TypeScript and the production build passed. `proof.json` records observed geometry, actual stored IDs and the source file fingerprint. These are author checks, not whole-CMS completion evidence.
