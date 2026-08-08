import type { Sha256Digest } from './identifiers.js';
import type { UnicodeSpan } from './span.js';

export const entityTypes = [
  'PERSON', 'EMAIL', 'PHONE', 'ADDRESS', 'LOCATION', 'ORGANIZATION',
  'DATE_OF_BIRTH', 'SSN', 'NATIONAL_ID', 'PASSPORT', 'DRIVER_LICENSE',
  'CREDIT_CARD', 'BANK_ACCOUNT', 'ROUTING_NUMBER', 'MEDICAL_RECORD',
  'HEALTH_PLAN_ID', 'ACCOUNT_ID', 'USERNAME', 'IP_ADDRESS', 'MAC_ADDRESS',
  'API_KEY', 'ACCESS_TOKEN', 'PASSWORD', 'CUSTOM'
] as const;

export type EntityType = (typeof entityTypes)[number];
export type DetectorSource = 'REGEX' | 'CHECKSUM' | 'STRUCTURED' | 'DICTIONARY' | 'MODEL' | 'MANUAL';

export interface DetectorReference {
  readonly id: string;
  readonly version: string;
  readonly ruleId?: string;
}

export interface DetectionEvidence {
  readonly id: string;
  readonly entityType: EntityType;
  readonly span: UnicodeSpan;
  readonly confidence: number;
  readonly source: DetectorSource;
  readonly detector: DetectorReference;
}

export interface DetectionSet {
  readonly extractionRevision: Sha256Digest;
  readonly detectorBundleVersion: string;
  readonly complete: boolean;
  readonly evidence: readonly DetectionEvidence[];
}
