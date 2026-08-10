// Generated from canonical JSON Schemas by tooling/generate-typescript.ts. Do not edit.

/**
 * Bounded cursor page of privacy-minimized job events.
 */
export interface JobEventPage {
  schemaVersion: '1.0.0';
  jobId: string;
  nextCursor: number;
  /**
   * @maxItems 100
   */
  events: JobEvent[];
}
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
