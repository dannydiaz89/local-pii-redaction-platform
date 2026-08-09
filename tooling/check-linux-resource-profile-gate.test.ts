import { describe, expect, it } from 'vitest';

import { parseMaximumRssKiB, summarizeColdRuns } from './check-linux-resource-profile-gate.js';

describe('Linux resource-profile evidence helpers', () => {
  it('accepts only a single positive integer GNU-time RSS metric', () => {
    expect(parseMaximumRssKiB('123456\n')).toBe(123456);
    for (const invalid of ['', '0', '-1', '1.5', '12 KiB', '1\n2', '9007199254740992']) {
      expect(() => parseMaximumRssKiB(invalid)).toThrow(TypeError);
    }
  });

  it('summarizes cold runs without mutating the observations', () => {
    const observations = [130, 110, 120];
    expect(summarizeColdRuns(observations)).toEqual({ minimum: 110, median: 120, maximum: 130 });
    expect(observations).toEqual([130, 110, 120]);
    expect(() => summarizeColdRuns([])).toThrow(TypeError);
    expect(() => summarizeColdRuns([1, 0, 2])).toThrow(TypeError);
  });
});
