# `@local-pii/verification`

Deterministic residual-PII verification and bound verification attestations for canonical text,
including canonical string-value text reopened from native JSON.

## Responsibilities

- Re-scans canonical output using the pinned verification detector bundle.
- Produces privacy-minimized findings without detected source values.
- Binds verification to input, output, policy, plan, writer receipt, and component identities.
- Permits an intentionally retained reviewed match only when its type and mapped output offsets
  exactly match the value-free rejected-span provenance in a valid reviewed plan.
- Computes canonical attestation digests and reports pass/fail/uncertain outcomes.
- Publishes the current text verification capability descriptor.
- Provides a non-authorizing independent DOCX foundation that owns a strict bounded ZIP/XML parser,
  validates package inventory and content-type/relationship graphs, enumerates retained XML carriers,
  reconciles exact native per-carrier plan/receipt deltas, and performs privacy-safe residual scans.

## Boundary

Verification judges an already-produced candidate artifact. It does not publish files, repair output,
or guarantee that every possible form of PII was detected.

The independent DOCX function is deliberately not the public `docx-redact-v1` verifier. It does not
call or import the DOCX adapter and has no filesystem side effects, but it also does not yet reproduce
the extraction revision, independently prove that the caller declared every adapter-qualified carrier,
apply reviewed-residual exceptions, produce a core-bound verification attestation, or prove Office
renderer fidelity. Its result always has `authorizesPublication: false` and `fidelityVerified: false`.

```sh
pnpm --filter @local-pii/verification build
pnpm exec vitest run packages/verification/test
```
