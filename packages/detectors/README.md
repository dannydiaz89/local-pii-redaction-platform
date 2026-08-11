# `@local-pii/detectors`

Bounded text detectors and deterministic/contextual evidence composition.

## Responsibilities

- Detects the current deterministic PII entity set using bundled rules and checksums.
- Publishes detector capabilities and explicit input, candidate, and detection limits.
- Validates contextual-provider evidence before combining it with deterministic evidence.
- Applies exact adapter-owned JSON/CSV structured regions from a validated policy, with configured
  regions classified as whole values and unmatched regions retaining free-text rules.
- Fails closed when combined evidence exceeds the advertised bound.

## Boundary

This package produces immutable `DetectionEvidence`; it does not resolve overlaps, choose redaction
actions, modify text, or make network requests. Contextual providers implement the exported provider
port and remain separate packages.

## Public entry point

Use `detectDeterministic` for rules-only detection,
`detectDeterministicWithStructure` for exact structured policy, or
`createCompositeTextDetector` for an explicit hybrid composition.

```sh
pnpm --filter @local-pii/detectors build
pnpm exec vitest run packages/detectors/test
```
