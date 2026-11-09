# Default Search block: supplied source controls the decision

The user's goal is WordPress behavior on React and PostgreSQL. An earlier internal plan broadly promised to preserve named-author filters through search. That planning promise is not a user instruction and must yield to the supplied source.

Root and both backend reviewers read the supplied `wp-includes/blocks/search.php`: the default form action is `home_url('/')`, its input is named `s`, and hidden parameters come only from explicit block `attributes.query` (lines17–38,96–102,215–220). An ordinary empty query attribute does not inherit the current archive's author, name, date, taxonomy or counters. No PHP was executed.

The native Classic and Twenty Twenty-Five scenes at75e44 correctly demonstrate that a default core/search form leaves an empty numeric/name intersection for a site-wide search. Their actual requests, original JSON/PNGs and earlier expectation failures remain immutable. This is a correction to the internal expectation and earlier bug classification, not a runtime or private-data disclosure finding. The independent source inspection agrees.

Keep the existing75e44 runtime and default global core/search behavior. Do not add ambient hidden fields or the proposed original-path field to the server listing context. Do not merge the test-only98f44b2 search successor. Its immutable aaf probe produced2passes13failures/15 in each server mode against the broad internal filtered-search expectation; retain those bytes and logs, explicitly classified as a source-policy mismatch. No production change occurred.

WorldAct's existing local Classic archive form and paging/history transport retain their bounded filter-preserving behavior. That does not describe the default source Search block. The supplied source's explicit block query attributes are a separate fidelity gap in the current renderer, which ignores them; their implementation is not certified by this named-author package.

Native review must finish source-correct default global Search controls on the unchanged75e44 runtime, then complete ownership/privacy/path checks and cleanup. All75 backend/independent full-suite certificates remain scoped to their actual candidate. Successful private archives remain retained until exact release CI succeeds. The live MAIN remains31931 until final native acceptance, a fresh current-data backup, preservation verification and the release build.
