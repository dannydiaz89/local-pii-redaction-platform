// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * At-least-once safe job event carrying no document values or excerpts.
 */
export interface JobEvent {
  schemaVersion: '1.0.0';
  id: string;
  jobId: string;
  cursor: number;
  revision: number;
  type: 'JOB_CREATED' | 'STATE_CHANGED' | 'REVIEW_REQUIRED' | 'JOB_COMPLETED' | 'JOB_FAILED' | 'CANCELLATION_REQUESTED';
  occurredAt: string;
  counts?: {
    [k: string]: number;
  };
}
