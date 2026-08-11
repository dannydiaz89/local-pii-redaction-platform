import type {
  DetectionEvidence,
  EntityType,
  CanonicalRegion,
  CanonicalRegionV1,
  Sha256Digest
} from '@local-pii/domain';
import type { TypedLabelPlan, TypedLabelReviewProvenance } from '@local-pii/redaction';
import type { ResolutionSet } from '@local-pii/span-resolution';
import type { CapabilitiesCapabilityManifestContract } from '@local-pii/contracts';
import type { RedactionWriterReceiptContract } from '@local-pii/contracts';
import type { VerificationVerificationReportV2Contract } from '@local-pii/contracts';
import type { EffectivePolicy, PolicyDecision } from '@local-pii/policy';

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
  getCapabilities(signal?: AbortSignal): Promise<CapabilityManifest>;
}

/**
 * The canonical text and byte digest exposed by a caller-owned artifact session.
 * `reference` is deliberately opaque: it can be a CLI path today or an artifact
 * identifier in a durable service without changing the application contract.
 */
export interface TextArtifact {
  readonly reference: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
  readonly extractionRevision: Sha256Digest;
  readonly text: string;
  readonly hasUtf8Bom: boolean;
  /** Complete adapter-owned source regions for structured canonical text. */
  readonly regions?: readonly CanonicalRegion[];
}

export interface StagedTextArtifact {
  readonly reference: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
  readonly receipt: WriterReceipt;
}

export interface PublishedTextArtifact {
  readonly reference: string;
  readonly byteLength: number;
  readonly digest: Sha256Digest;
}

export interface ArtifactWriterReference {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
}

export type WriterReceipt = RedactionWriterReceiptContract.WriterReceipt;

/** Reads the caller-selected input only after application capability preflight. */
export interface TextInputSession {
  input(signal?: AbortSignal): Promise<TextArtifact>;
}

/**
 * Owns transient staging and publication. The core never assumes a filesystem,
 * database, object store, or retention policy.
 */
export interface TextArtifactSession {
  readonly writer: ArtifactWriterReference;
  /** Applies the immutable plan and returns private staged bytes plus an action receipt. */
  stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact>;
  reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifact>;
  /**
   * Irrevocable commit barrier: check cancellation before starting, then atomically publish the
   * exact staged digest/length to a definitive result without reporting a post-commit cancellation.
   */
  publish(staged: StagedTextArtifact, signal?: AbortSignal): Promise<PublishedTextArtifact>;
  discard(staged: StagedTextArtifact, signal?: AbortSignal): Promise<void>;
}

export type TextProcessingSession = TextInputSession & TextArtifactSession;

export interface TextDetectionPort {
  readonly detectorBundleVersion: string;
  detect(
    text: string,
    extractionRevision: Sha256Digest,
    signal?: AbortSignal
  ): Promise<readonly DetectionEvidence[]>;
  detectStructured?(
    request: Readonly<{
      text: string;
      extractionRevision: Sha256Digest;
      regions: readonly CanonicalRegionV1[];
      structure: EffectivePolicy['structure'];
    }>,
    signal?: AbortSignal
  ): Promise<readonly DetectionEvidence[]>;
}

export interface TextVerificationFinding {
  readonly code: string;
  readonly severity: 'ERROR' | 'WARNING';
  readonly blocking: boolean;
  readonly entityType?: EntityType;
  readonly start?: number;
  readonly end?: number;
}

/** Independent port: verification need not reuse the redaction detector. */
export interface TextVerificationReport {
  readonly schemaVersion: string;
  readonly profile: string;
  readonly outcome: 'PASS' | 'FAIL';
  readonly detectorBundleVersion: string;
  readonly checks: readonly string[];
  readonly findings: readonly TextVerificationFinding[];
}

export interface TextVerificationPort {
  readonly attestation: {
    readonly profile: ComponentReference;
    readonly verifier: ComponentReference;
    readonly detectorBundle: ComponentReference;
    readonly application: ComponentReference;
  };
  verify(
    text: string,
    extractionRevision: Sha256Digest,
    signal?: AbortSignal
  ): Promise<TextVerificationReport>;
  attest(
    request: BoundTextVerificationRequest,
    signal?: AbortSignal
  ): Promise<TextVerificationAttestation>;
}

export interface BoundTextVerificationRequest {
  readonly reopenedText: string;
  readonly input: { readonly digest: Sha256Digest; readonly byteLength: number };
  readonly output: {
    readonly digest: Sha256Digest;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly extractionRevision: Sha256Digest;
  };
  readonly capabilityDigest: Sha256Digest;
  readonly plan: TypedLabelPlan;
  readonly policy: PolicyBinding;
  readonly writerReceipt: WriterReceipt;
  readonly writer: ArtifactWriterReference;
  readonly application: ComponentReference;
}

export interface ComponentReference {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
}

export type TextVerificationAttestation =
  VerificationVerificationReportV2Contract.VerificationAttestationV2;

export interface TextProcessingApplicationDependencies {
  readonly capabilityProvider: CapabilityProvider;
  readonly detector: TextDetectionPort;
  readonly verifier: TextVerificationPort;
}

export interface TextCommand {
  readonly session: TextInputSession;
  readonly requirement: CapabilityRequirement;
  /** Optional structured selection policy for a scan; absent means free-text defaults. */
  readonly policy?: EffectivePolicy;
  readonly signal?: AbortSignal;
}

export interface RedactTextCommand {
  readonly session: TextProcessingSession;
  readonly requirement: CapabilityRequirement;
  /** The immutable compiled policy that governs this entire redaction. */
  readonly policy: EffectivePolicy;
  /** Optional exact human-review snapshot applied after deterministic resolution. */
  readonly review?: RedactionReviewSnapshot;
  readonly signal?: AbortSignal;
}

export type RedactionReviewDecision =
  | { readonly sourceSpanId: string; readonly action: 'ACCEPT' | 'REJECT' }
  | { readonly sourceSpanId: string; readonly action: 'RETYPE'; readonly entityType: EntityType };

export interface RedactionReviewSnapshot {
  readonly binding: TypedLabelReviewProvenance;
  readonly decisions: readonly RedactionReviewDecision[];
}

export interface PolicyBinding {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
  readonly riskTier: 'LOW' | 'MODERATE' | 'HIGH';
}

export interface PolicySpanDecision extends PolicyDecision {
  readonly spanId: string;
  readonly evidenceIds: readonly string[];
  readonly reviewAction?: RedactionReviewDecision['action'];
}

export interface TextInspectionResult {
  readonly artifact: TextArtifact;
}

export interface TextScanResult {
  readonly artifact: TextArtifact;
  readonly detectorBundleVersion: string;
  readonly evidence: readonly DetectionEvidence[];
  readonly resolution: ResolutionSet;
  readonly outcome: 'SUCCEEDED' | 'NEEDS_REVIEW';
}

export interface TextVerifyResult {
  readonly artifact: TextArtifact;
  readonly verification: TextVerificationReport;
}

export interface TextRedactionResult {
  readonly input: TextArtifact;
  readonly policy: PolicyBinding;
  readonly policyDecisions: readonly PolicySpanDecision[];
  readonly detectorBundleVersion: string;
  readonly evidence: readonly DetectionEvidence[];
  readonly resolution: ResolutionSet;
  readonly plan: TypedLabelPlan;
  readonly writerReceipt: WriterReceipt;
  readonly verification: TextVerificationAttestation;
  readonly published: PublishedTextArtifact;
}

export interface TextProcessingApplication {
  getCapabilities(context: ApplicationContext, signal?: AbortSignal): Promise<CapabilityManifest>;
  inspect(command: TextCommand, context: ApplicationContext): Promise<TextInspectionResult>;
  scan(command: TextCommand, context: ApplicationContext): Promise<TextScanResult>;
  verify(command: TextCommand, context: ApplicationContext): Promise<TextVerifyResult>;
  redact(command: RedactTextCommand, context: ApplicationContext): Promise<TextRedactionResult>;
}
