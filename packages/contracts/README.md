# `@local-pii/contracts`

Canonical, language-neutral data contracts for every process and package boundary.

## Responsibilities

- Owns versioned JSON Schemas and the OpenAPI description.
- Exports generated TypeScript contract namespaces.
- Provides strict AJV validation and semantic capability checks.
- Computes canonical writer-receipt and verification-attestation digests.
- Drives the shared TypeScript/Python valid and invalid fixture corpus.
- Publishes shared conservative byte, value-free detection-detail, and value-free conflict-detail
  ceilings for the ephemeral local preview boundary.
- Defines the bounded append-only review request/set contracts used for value-free optimistic
  decision replay without changing the immutable detector evidence contracts.
- Retains detection v1 and adds detection v2 plus canonical-region/native-location schemas for
  typed JSON pointer, CSV cell, and narrow DOCX paragraph provenance.
- Retains redaction-policy v1 and adds redaction-policy v2 for exact JSON Pointer classification,
  explicit CSV delimiter/header behavior, and exact CSV index/header classification.
- Adds policy-bound CLI scan-report v2 and redaction-report v3 contracts without loosening the
  existing scan v1 or bundled-policy redaction v2 report schemas.
- Retains batch-scan-report v1 and adds append-only v2 so an explicit `REQUIRE_COMPLETE` or
  `ALLOW_PARTIAL` completion policy is machine-visible without breaking existing report consumers.
- Defines v4 reviewed-redaction admission and v2 redaction-plan contracts that bind an exact scan,
  append-only review revision/digest, effective value-free decisions, policy, and writer provenance.

## Boundary

Schemas under `schemas/` are the source of truth. Files under `src/generated/` are generated and
must not be edited by hand. Domain behavior and application workflows belong in other packages.

## Development

```sh
pnpm --filter @local-pii/contracts build
pnpm contracts:check
```

When a contract changes, update its versioned schema and fixtures, regenerate bindings, and verify
both language implementations before committing.
