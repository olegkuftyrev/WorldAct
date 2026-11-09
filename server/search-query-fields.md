# Explicit Search block query fields

`core/search` emits one hidden input for each own entry of its saved `query`
object or array, after the visible required `s` input and before the button.
The form keeps its root GET action. A block without explicit fields remains a
global search; it does not inherit archive filters or pagination counters.

Fields retain the order present in canonical saved data. Raw block comments
retain their text order; JSONB-backed JSON blocks can have a different stored
key order. Duplicate `s` inputs are both submitted, preserving WorldAct's
existing duplicate-parameter 400 policy. Custom names remain query data and do
not add new supported listing features.

Strings remain strings, true becomes `1`, false/null become empty values, finite
numbers use JavaScript's string representation, and nested JSON containers
become `Array`. Scalar top-level `query` values emit no fields. Existing save
sanitization and the preview endpoint's object-only input policy remain in
effect. Arbitrary PHP float spelling, numeric-key ordering, invalid byte
encodings and lost JSON numeric distinctions are outside this bounded contract.

Only the explicit fields use the source-derived attribute escape: the 252
case-sensitive HTML401 entity names, excluding `apos`, and WordPress's numeric
reference normalization. It preserves valid references without recursively
decoding them. Unsupported names and invalid numeric references remain literal
text after HTML parsing. Escaping generic content and visible form controls is
unchanged.

The builder preflights escaped UTF-8 bytes for the entire form before allocating
expanded fields, including its existing prefix/suffix. It uses the remaining
shared 8 MiB render allowance; the normal renderer still charges output once.
Repeated reusable blocks share that allowance. Excess output returns controlled
413 rather than truncated or partial successful HTML. The bound applies to
generated block output before sanitation and the outer HTTP envelope.

The helper is synchronous and uses no database, request or account state. It
adds no routing authority, grant observation or asynchronous work. This contract
does not establish full PHP/WordPress compatibility or browser acceptance; those
are separately scoped in the release evidence.
