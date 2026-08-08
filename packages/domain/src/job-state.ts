export const jobStates = [
  'QUEUED', 'VALIDATING', 'EXTRACTING', 'DETECTING', 'RESOLVING', 'NEEDS_REVIEW',
  'REDACTING', 'VERIFYING', 'CANCELLING', 'VERIFIED', 'SUCCEEDED', 'FAILED',
  'CANCELLED', 'EXPIRED'
] as const;

export type JobState = (typeof jobStates)[number];

const transitions: Readonly<Record<JobState, readonly JobState[]>> = {
  QUEUED: ['VALIDATING', 'CANCELLING', 'CANCELLED', 'FAILED'],
  VALIDATING: ['EXTRACTING', 'CANCELLING', 'FAILED'],
  EXTRACTING: ['DETECTING', 'CANCELLING', 'FAILED'],
  DETECTING: ['RESOLVING', 'CANCELLING', 'FAILED'],
  RESOLVING: ['NEEDS_REVIEW', 'REDACTING', 'SUCCEEDED', 'CANCELLING', 'FAILED'],
  NEEDS_REVIEW: ['RESOLVING', 'CANCELLING', 'CANCELLED', 'FAILED'],
  REDACTING: ['VERIFYING', 'CANCELLING', 'FAILED'],
  VERIFYING: ['VERIFIED', 'CANCELLING', 'FAILED'],
  CANCELLING: ['CANCELLED', 'FAILED'],
  VERIFIED: ['EXPIRED'],
  SUCCEEDED: ['EXPIRED'],
  FAILED: ['EXPIRED'],
  CANCELLED: ['EXPIRED'],
  EXPIRED: []
};

export function canTransition(from: JobState, to: JobState): boolean {
  return transitions[from].includes(to);
}

export function transitionJob(from: JobState, to: JobState): JobState {
  if (!canTransition(from, to)) throw new Error(`Invalid job transition: ${from} -> ${to}`);
  return to;
}

export function isTerminalState(state: JobState): boolean {
  return state === 'VERIFIED' || state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED' || state === 'EXPIRED';
}
