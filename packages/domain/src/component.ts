import { createHash } from 'node:crypto';

import { parseSha256Digest, type Sha256Digest } from './identifiers.js';

const componentIdPattern = /^[a-z][a-z0-9-]{2,63}$/u;
const semverPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;

/**
 * Digest of a versioned component identity, bound into plans, writer receipts, and verification
 * attestations so a report names exactly which writer, verifier, profile, and detector bundle
 * produced it.
 *
 * This attests *identity*, not code: it is a function of the id and version and nothing else, so
 * it distinguishes two versions of a component but cannot detect that a given version's code was
 * altered. A digest over the built artifact would attest code, but it cannot be a source literal —
 * the source would have to contain its own hash — and the suites run from TypeScript sources while
 * the CLI runs from `dist`, so the two would disagree. Real code attestation therefore needs a
 * build-time injected value, which this repository does not yet produce.
 *
 * Deriving it rather than copying a literal is what matters here: a hand-maintained constant that
 * nothing recomputes drifts silently at the next version bump, and a report would then claim a
 * component identity that corresponds to nothing.
 */
export function componentIdentityDigest(id: string, version: string): Sha256Digest {
  if (!componentIdPattern.test(id)) throw new TypeError('Invalid component id');
  if (!semverPattern.test(version)) throw new TypeError('Invalid component version');
  return parseSha256Digest(`sha256:${createHash('sha256').update(`local-pii:${id}:${version}`, 'utf8').digest('hex')}`);
}
