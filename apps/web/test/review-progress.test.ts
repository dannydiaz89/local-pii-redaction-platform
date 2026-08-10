import { describe, expect, it } from 'vitest';

import { findUnreviewedDetectionId, summarizeReviewProgress } from '../src/review-progress.js';

describe('review progress', () => {
  it('counts effective reviewed targets rather than append-only history entries', () => {
    expect(summarizeReviewProgress(4, [
      { targetDetectionId: 'first' },
      { targetDetectionId: 'first' },
      { targetDetectionId: 'second' }
    ])).toEqual({ saved: 2, remaining: 2 });
  });

  it('moves cyclically among rows without a saved or pending decision', () => {
    const detections = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];
    const reviewed = new Set(['first']);
    const drafted = new Set(['second']);

    expect(findUnreviewedDetectionId(detections, reviewed, drafted, undefined, 'next')).toBe('third');
    expect(findUnreviewedDetectionId(detections, reviewed, drafted, 'third', 'next')).toBe('third');
    expect(findUnreviewedDetectionId(detections, reviewed, drafted, undefined, 'previous')).toBe('third');
    expect(findUnreviewedDetectionId(detections, new Set(['first', 'third']), drafted, undefined, 'next'))
      .toBeUndefined();
  });
});
