import type { DetectionEvidence, Sha256Digest } from '@local-pii/domain';

export interface Extraction {
  readonly revision: Sha256Digest;
  readonly textLength: number;
  readonly canonicalTextRef: string;
  readonly sourceMapRef: string;
}

export interface DocumentAdapter {
  readonly id: string;
  readonly version: string;
  extract(inputArtifactId: string): Promise<Extraction>;
}

export interface EvidenceProvider {
  readonly id: string;
  readonly version: string;
  detect(extraction: Extraction): Promise<readonly DetectionEvidence[]>;
}

export interface CapabilityRequirement {
  readonly detectorIds: readonly string[];
  readonly verificationProfile: string;
}

export interface CapabilitySnapshot {
  readonly detectorIds: readonly string[];
  readonly verificationProfiles: readonly string[];
}
