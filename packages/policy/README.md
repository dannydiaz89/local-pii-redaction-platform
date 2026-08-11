# `@local-pii/policy`

Validation, compilation, capability evaluation, and execution semantics for redaction policies.

## Responsibilities

- Validates canonical policy schemas and additional semantic constraints.
- Retains schema v1 and compiles schema v2 exact JSON Pointer and CSV column selectors into one
  immutable effective structure policy. Duplicate or ambiguous selectors fail closed.
- Compiles immutable effective policies and capability requirements.
- Explains whether a capability manifest can satisfy a policy and operation.
- Evaluates accepted spans into deterministic policy decisions.
- Applies configured terminal actions for explicit accepted/retyped review decisions while keeping
  rejected spans as value-free, plan-bound review outcomes.
- Publishes the bundled development example policies.

## Boundary

Policy decides what action is required; it does not detect PII, resolve evidence overlap, transform
text, or write artifacts. Bundled policies are examples and are not compliance certifications.
Structured policy confidence represents exact configured classification, not independent semantic
proof. Wildcards, ignore rules, inheritance, includes, and executable policy content are not part of
the current contract.

```sh
pnpm --filter @local-pii/policy build
pnpm exec vitest run packages/policy/test
```
