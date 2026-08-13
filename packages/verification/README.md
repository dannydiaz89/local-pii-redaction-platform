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
  for adapter-supplied accepted inputs, reconstructs the complete frozen canonical source-carrier/map
  order, reproduces the v3 extraction revision across fragmented run nodes, reconciles exact native
  per-carrier plan/receipt deltas, permits only exact action-adjusted rejected-review residuals, binds
  privacy-safe supplied application-attestation inputs, and performs privacy-safe residual scans.

## Boundary

Verification judges an already-produced candidate artifact. It does not publish files, repair output,
or guarantee that every possible form of PII was detected.

The independent DOCX function is deliberately not the public `docx-redact-v1` verifier. It does not
call or import the DOCX adapter and has no filesystem side effects, but it also does not yet reproduce
the adapter's complete feature-grammar validation or malicious-input qualification. It does prove that
for an adapter-supplied accepted input, the caller declared every carrier in the frozen source-carrier
taxonomy and that the v3 extraction revision matches. Exact rejected review decisions are supported,
and successful or residual-failure results expose only a digest of the supplied application inputs
and complete supplied plan/review semantics. The foundation does not independently recompute the
compiled plan identity, so the digest binds the supplied review decisions without authenticating
that they came from the plan compiled by the application.
That digest is deliberately not a canonical v2 verification attestation: the function still cannot
produce a core-bound DOCX attestation or prove Office renderer fidelity. Its result always has
`authorizesPublication: false` and `fidelityVerified: false`.

```sh
pnpm --filter @local-pii/verification build
pnpm exec vitest run packages/verification/test
```
