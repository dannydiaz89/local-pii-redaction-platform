import type { JobDetectionSummary, ReviewDecisionSummary } from '@local-pii/sdk';

export interface ReviewProgressSummary {
  readonly saved: number;
  readonly remaining: number;
}

export function summarizeReviewProgress(
  totalDetections: number,
  decisions: readonly Pick<ReviewDecisionSummary, 'targetDetectionId'>[]
): ReviewProgressSummary {
  if (!Number.isSafeInteger(totalDetections) || totalDetections < 0) {
    throw new TypeError('The review total is invalid.');
  }
  const saved = Math.min(
    totalDetections,
    new Set(decisions.map(({ targetDetectionId }) => targetDetectionId)).size
  );
  return Object.freeze({ saved, remaining: totalDetections - saved });
}

export function findUnreviewedDetectionId(
  detections: readonly Pick<JobDetectionSummary, 'id'>[],
  reviewedIds: ReadonlySet<string>,
  draftedIds: ReadonlySet<string>,
  anchorId: string | undefined,
  direction: 'previous' | 'next'
): string | undefined {
  if (detections.length === 0) return undefined;
  const step = direction === 'next' ? 1 : -1;
  const anchorIndex = anchorId === undefined
    ? (direction === 'next' ? -1 : detections.length)
    : detections.findIndex(({ id }) => id === anchorId);
  const startIndex = anchorIndex < 0
    ? (direction === 'next' ? -1 : detections.length)
    : anchorIndex;

  for (let offset = 1; offset <= detections.length; offset += 1) {
    const index = (startIndex + step * offset + detections.length) % detections.length;
    const candidate = detections[index];
    if (candidate !== undefined
      && !reviewedIds.has(candidate.id)
      && !draftedIds.has(candidate.id)) return candidate.id;
  }
  return undefined;
}
