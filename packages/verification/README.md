# `@local-pii/verification`

Deterministic residual-PII verification and bound verification attestations for canonical text.

## Responsibilities

- Re-scans canonical output using the pinned verification detector bundle.
- Produces privacy-minimized findings without detected source values.
- Binds verification to input, output, policy, plan, writer receipt, and component identities.
- Computes canonical attestation digests and reports pass/fail/uncertain outcomes.
- Publishes the current text verification capability descriptor.

## Boundary

Verification judges an already-produced candidate artifact. It does not publish files, repair output,
or guarantee that every possible form of PII was detected.

```sh
pnpm --filter @local-pii/verification build
pnpm exec vitest run packages/verification/test
```
