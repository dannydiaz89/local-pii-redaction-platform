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
