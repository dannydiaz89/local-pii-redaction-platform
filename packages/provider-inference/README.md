# `@local-pii/provider-inference`

Experimental contextual detection provider over the local inference service's subprocess profile.

## Responsibilities

- Spawns `python -m local_pii_inference --bundle <dir>` and speaks length-prefixed JSON frames
  over stdio; no socket is opened.
- Verifies the bundle manifest on disk against the identity the service reports at readiness and
  after every detection, and binds the model digest into the detector bundle version.
- Chunks canonical text within the detect-request contract, validates every response against the
  detect-response contract and the source text bounds, and maps chunk-relative spans back to
  absolute Unicode code-point offsets.
- Emits privacy-minimised evidence: spans, types, model confidence, and model provenance only.

## Boundary and limitations

The provider never downloads or selects a model. The bundle directory is operator-supplied and
digest-pinned. Text necessarily crosses the subprocess pipe; the service is designed to keep it out
of logs and errors, but the host's process, swap, and diagnostic state remain outside the
application's transient-value guarantee. Chunks are contiguous and non-overlapping in this
version; an entity that straddles a chunk boundary can be missed.
