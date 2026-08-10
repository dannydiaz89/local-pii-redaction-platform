# `@local-pii/policy`

Validation, compilation, capability evaluation, and execution semantics for redaction policies.

## Responsibilities

- Validates canonical policy schemas and additional semantic constraints.
- Compiles immutable effective policies and capability requirements.
- Explains whether a capability manifest can satisfy a policy and operation.
- Evaluates accepted spans into deterministic policy decisions.
- Publishes the bundled development example policies.

## Boundary

Policy decides what action is required; it does not detect PII, resolve evidence overlap, transform
text, or write artifacts. Bundled policies are examples and are not compliance certifications.

```sh
pnpm --filter @local-pii/policy build
pnpm exec vitest run packages/policy/test
```
