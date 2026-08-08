import { describe, expect, it } from 'vitest';

import { canTransition, isTerminalState, transitionJob } from '../src/index.js';

describe('job state transitions', () => {
  it('supports the verified redaction path', () => {
    const path = ['QUEUED', 'VALIDATING', 'EXTRACTING', 'DETECTING', 'RESOLVING', 'REDACTING', 'VERIFYING', 'VERIFIED'] as const;
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1];
      const to = path[index];
      if (from === undefined || to === undefined) throw new Error('Invalid test fixture');
      expect(canTransition(from, to)).toBe(true);
    }
  });

  it('does not allow a verified artifact to return to processing', () => {
    expect(() => transitionJob('VERIFIED', 'REDACTING')).toThrow('Invalid job transition');
    expect(isTerminalState('VERIFIED')).toBe(true);
  });
});
