# `@local-pii/adapter-json`

Native JSON extraction and value-only redaction for the local rules profile.

The adapter parses bounded UTF-8 JSON, excludes object keys from detection,
maps string values into canonical Unicode code-point regions, and applies a
typed-label plan back to the matching JSON value tokens. Untouched JSON bytes,
including keys, whitespace, ordering, numbers, booleans, and nulls, remain
unchanged. A changed string token is serialized with standard JSON escaping.

Duplicate object keys, malformed JSON, symbolic links, special files, overly
deep documents, and inputs beyond the adapter limits fail closed. Publication
reuses the private same-directory stage and no-clobber hard-link boundary from
`@local-pii/adapter-text`, then reparses and rescans the staged native JSON.

Filesystem and process-local sessions share the same native parser/writer/reopen semantics; the
process-local session selects no path and zeroes its owned buffers on disposal. Current scope is bounded whole-document JSON. JSON Pointer mappings remain
adapter-internal and keys are not redacted. Streaming, key transformation,
path-aware policies, and JSON Lines are not yet supported.
