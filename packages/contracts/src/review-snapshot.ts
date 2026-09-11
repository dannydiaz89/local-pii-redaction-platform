import { createHash } from 'node:crypto';

import type { CommonEntityTypeContract } from './generated/index.js';

export type ReviewSnapshotDecision =
  | { readonly sourceSpanId: string; readonly action: 'ACCEPT' | 'REJECT' }
  | { readonly sourceSpanId: string; readonly action: 'RETYPE'; readonly entityType: CommonEntityTypeContract.EntityType };

export interface ReviewSnapshotDigestInput {
  /** Who took the decisions; a fixed reviewer identity, never a user-controlled value. */
  readonly reviewer: string;
  readonly extractionRevision: string;
  readonly decisions: readonly ReviewSnapshotDecision[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, unknown>>)[key])}`
  ).join(',')}}`;
}

/**
 * Canonical digest of an explicit review snapshot. It covers only span identifiers,
 * actions, and the extraction revision, so it binds the decisions to the exact resolved
 * text without retaining a value, path, or offset. Compositions that build a review
 * outside a durable job store use this so the plan's review provenance is reproducible.
 */
export function computeReviewSnapshotDigest(input: ReviewSnapshotDigestInput): string {
  const canonical = canonicalJson({
    schemaVersion: '1.0.0',
    reviewer: input.reviewer,
    extractionRevision: input.extractionRevision,
    decisions: input.decisions
  });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
