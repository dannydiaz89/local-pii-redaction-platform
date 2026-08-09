import type { CorrelationId, DetectionEvidence, Sha256Digest } from '@local-pii/domain';
import type { CapabilitiesCapabilityManifestContract } from '@local-pii/contracts';

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
  readonly contractVersion: string;
  readonly engineModes: readonly CapabilityEngineMode[];
  readonly formatId: string;
  readonly operation: CapabilityOperation;
  readonly detectorIds: readonly string[];
  readonly detectorKinds: readonly CapabilityDetectorKind[];
  readonly transformationActions: readonly CapabilityTransformationAction[];
  readonly verificationProfile: string;
  readonly maximumInputBytes: number;
  readonly minimumQualification: CapabilityQualification;
}

export type CapabilityManifest = CapabilitiesCapabilityManifestContract.CapabilityManifest;
export type CapabilityEngineMode = CapabilityManifest['engineMode'];
export type CapabilityFormat = CapabilityManifest['formats'][number];
export type CapabilityOperation = CapabilityFormat['operations'][number];
export type CapabilityDetectorKind = CapabilityManifest['detectors'][number]['kinds'][number];
export type CapabilityTransformationAction = CapabilityManifest['transformations'][number]['action'];
export type CapabilityQualification = CapabilitiesCapabilityManifestContract.Qualification;

export interface ApplicationContext {
  readonly correlationId: string;
}

export interface CapabilityProvider {
  getCapabilities(): Promise<CapabilityManifest>;
}

export interface RulesOnlyTextPipeline<Request, Result> {
  execute(request: Request, correlationId: CorrelationId): Promise<Result>;
}

export interface ExecuteRulesOnlyTextCommand<Request> {
  readonly request: Request;
  readonly requirement: CapabilityRequirement;
}

export interface JobApplicationDependencies<Request, Result> {
  readonly capabilityProvider: CapabilityProvider;
  readonly rulesOnlyTextPipeline: RulesOnlyTextPipeline<Request, Result>;
}

export interface JobApplication<Request, Result> {
  getCapabilities(context: ApplicationContext): Promise<CapabilityManifest>;
  executeRulesOnlyText(
    command: ExecuteRulesOnlyTextCommand<Request>,
    context: ApplicationContext
  ): Promise<Result>;
}
