# Native renderer attribute transport

The supplied `class-wp-rest-block-renderer-controller.php` validates and
sanitizes its attributes against the registered block schemas. Its REST
helpers accept numeric strings and the boolean forms `true`, `false`, `1`,
and `0` (case-insensitive for words). Native server-side previews can use
GET bracket query parameters, which arrive as strings.

WorldAct uses its fixed, installed `block.json` metadata to normalize these
declared types for GET and POST before rendering. Text stays text; omitted
attributes retain renderer defaults. Explicit object properties and array
item schemas are traversed without guessing types for unknown properties.
Existing extension/support attributes remain available. No source callback,
schema-supplied code or user module is executed.

Invalid declared scalar/container types, nonfinite numbers and unsafe
integers are rejected. Input is bounded to 100,000 encoded bytes, 25,000
values and 25 nesting levels; prototype-related keys are discarded. This
is a bounded compatibility normalizer, not a complete JSON Schema engine.
Rendering still applies the existing sanitization, permission, query and
output limits.
