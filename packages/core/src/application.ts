import {
  SafeError,
  isNativeLocationV1,
  isNativeLocationV2,
  isNativeLocationV3,
  isNativeLocationV4,
  nativeLocationIdentity,
  parseCorrelationId,
  parseSha256Digest,
  unicodeCodePointLength,
  type CanonicalRegion,
  type CanonicalRegionV1,
  type DetectionEvidence,
  type CorrelationId
} from '@local-pii/domain';
import {
  assertContract,
  computeVerificationAttestationDigest,
  computeWriterReceiptDigest
} from '@local-pii/contracts';
import { compileTypedLabelPlan } from '@local-pii/redaction';
import { resolveEvidence } from '@local-pii/span-resolution';
import {
  compileCapabilityRequirement,
  evaluateAcceptedSpan,
  evaluateReviewedEntity
} from '@local-pii/policy';

import { assertCapabilityManifest, assertCapabilities, digestCapabilityManifest } from './preflight.js';
import type {
  ApplicationContext,
  CapabilityManifest,
  BoundTextVerificationRequest,
  RedactTextCommand,
  RedactionReviewDecision,
  TextCommand,
  TextProcessingApplication,
  TextProcessingApplicationDependencies,
  TextScanResult,
  TextVerificationAttestation,
  WriterReceipt
} from './ports.js';

const fallbackCorrelationId = 'cor_core_application';
const redactionPlanSchemaIds = {
  '1.0.0': 'https://local-pii.dev/schemas/redaction/redaction-plan/1.0.0',
  '2.0.0': 'https://local-pii.dev/schemas/redaction/redaction-plan/2.0.0'
} as const;
const writerReceiptSchemaId = 'https://local-pii.dev/schemas/redaction/writer-receipt/1.0.0';
const verificationAttestationSchemaId = 'https://local-pii.dev/schemas/verification/verification-report/2.0.0';

function correlationId(context: ApplicationContext): CorrelationId {
  try {
    return parseCorrelationId(context.correlationId);
  } catch {
    throw new SafeError({
      code: 'SCHEMA_INVALID',
      message: 'The application request context is invalid.',
      retryable: false,
      correlationId: fallbackCorrelationId
    });
  }
}

function internalFailure(requestCorrelationId: CorrelationId): SafeError {
  return new SafeError({
    code: 'INTERNAL_ERROR',
    message: 'The application operation failed unexpectedly.',
    retryable: false,
    correlationId: requestCorrelationId
  });
}

function reviewPlanConflict(requestCorrelationId: CorrelationId): SafeError {
  return new SafeError({
    code: 'REDACTION_PLAN_CONFLICT',
    message: 'The saved review no longer matches this scan.',
    retryable: false,
    correlationId: requestCorrelationId
  });
}

function validatedReviewDecisions(
  command: RedactTextCommand,
  extractionRevision: string,
  availableSpanIds: ReadonlySet<string>,
  requestCorrelationId: CorrelationId
): ReadonlyMap<string, RedactionReviewDecision> {
  const review = command.review;
  if (review === undefined) return new Map();
  try {
    if (parseSha256Digest(review.binding.extractionRevision) !== extractionRevision
      || parseSha256Digest(review.binding.digest) !== review.binding.digest
      || !Number.isSafeInteger(review.binding.revision)
      || review.binding.revision < 0
      || review.binding.revision > 1000
      || review.binding.decisionCount !== review.binding.revision
      || review.decisions.length > review.binding.decisionCount) {
      throw new TypeError('Invalid review binding.');
    }
    const decisions = new Map<string, RedactionReviewDecision>();
    for (const decision of review.decisions) {
      if (!availableSpanIds.has(decision.sourceSpanId) || decisions.has(decision.sourceSpanId)) {
        throw new TypeError('Invalid review target.');
      }
      if (decision.action === 'RETYPE'
        && !command.policy.entities.some(({ entityType }) => entityType === decision.entityType)) {
        throw new TypeError('Invalid review entity type.');
      }
      decisions.set(decision.sourceSpanId, decision);
    }
    return decisions;
  } catch {
    throw reviewPlanConflict(requestCorrelationId);
  }
}

async function invoke<Result>(
  requestCorrelationId: CorrelationId,
  signal: AbortSignal | undefined,
  operation: () => Promise<Result>
): Promise<Result> {
  try {
    return await operation();
  } catch (error: unknown) {
    if (error instanceof SafeError) throw error;
    if (signal?.aborted === true) {
      throw new SafeError({
        code: 'OPERATION_CANCELLED',
        message: 'The operation was cancelled.',
        retryable: false,
        correlationId: requestCorrelationId
      });
    }
    throw internalFailure(requestCorrelationId);
  }
}

async function preflight(
  dependencies: TextProcessingApplicationDependencies,
  requirement: TextCommand['requirement'],
  requestCorrelationId: CorrelationId,
  signal: AbortSignal | undefined
): Promise<CapabilityManifest> {
  const manifest = await dependencies.capabilityProvider.getCapabilities(signal);
  assertCapabilities(requirement, manifest, requestCorrelationId);
  return manifest;
}

function sourceMapInvalid(requestCorrelationId: CorrelationId): never {
  throw new SafeError({
    code: 'SOURCE_MAP_INVALID',
    message: 'The structured source map is invalid.',
    retryable: false,
    correlationId: requestCorrelationId
  });
}

function validatedRegions(
  regions: readonly CanonicalRegion[],
  textLength: number,
  requestCorrelationId: CorrelationId
): readonly CanonicalRegion[] {
  const candidateRegions: unknown = regions;
  if (!Array.isArray(candidateRegions) || candidateRegions.length > 100_000) return sourceMapInvalid(requestCorrelationId);
  let previousEnd = 0;
  let previousIdentity: string | undefined;
  const locations = new Set<string>();
  for (const region of candidateRegions as readonly unknown[]) {
    if (region === null || typeof region !== 'object' || Array.isArray(region)) return sourceMapInvalid(requestCorrelationId);
    const candidate = region as Readonly<Record<string, unknown>>;
    if (
      (Object.keys(candidate).length !== 6 && Object.keys(candidate).length !== 7)
      || (candidate.schemaVersion !== '1.0.0'
        && candidate.schemaVersion !== '2.0.0'
        && candidate.schemaVersion !== '3.0.0'
        && candidate.schemaVersion !== '4.0.0')
      || candidate.offsetUnit !== 'UNICODE_CODE_POINT'
      || candidate.role !== 'VALUE'
      || !Number.isSafeInteger(candidate.start)
      || !Number.isSafeInteger(candidate.end)
      || (candidate.start as number) < previousEnd
      || (candidate.end as number) < (candidate.start as number)
      || (candidate.end as number) > textLength
    ) return sourceMapInvalid(requestCorrelationId);
    const location = candidate.location;
    if (!isNativeLocationV4(location)
      || (candidate.schemaVersion === '1.0.0' && !isNativeLocationV1(location))
      || (candidate.schemaVersion === '2.0.0' && !isNativeLocationV2(location))
      || (candidate.schemaVersion === '3.0.0' && !isNativeLocationV3(location))) {
      return sourceMapInvalid(requestCorrelationId);
    }
    if (location.kind === 'PDF_TEXT_ITEM'
      && (candidate.end as number) - (candidate.start as number) !== location.glyphCount) {
      return sourceMapInvalid(requestCorrelationId);
    }
    if (candidate.selector !== undefined) {
      const selector = candidate.selector;
      if (
        location.kind !== 'CSV_CELL'
        ||
        selector === null
        || typeof selector !== 'object'
        || Array.isArray(selector)
        || Object.keys(selector).length !== 1
        || typeof (selector as Readonly<Record<string, unknown>>).csvHeader !== 'string'
        || ((selector as Readonly<Record<string, unknown>>).csvHeader as string).length === 0
        || ((selector as Readonly<Record<string, unknown>>).csvHeader as string).length > 256
      ) return sourceMapInvalid(requestCorrelationId);
    }
    const identity = nativeLocationIdentity(location);
    if (locations.has(identity) && (location.kind !== 'DOCX_PART' || previousIdentity !== identity)) {
      return sourceMapInvalid(requestCorrelationId);
    }
    locations.add(identity);
    previousIdentity = identity;
    previousEnd = candidate.end as number;
  }
  return regions;
}

function regionForSpan(
  regions: readonly CanonicalRegion[],
  start: number,
  end: number
): CanonicalRegion | undefined {
  let low = 0;
  let high = regions.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const region = regions[middle];
    if (region === undefined) return undefined;
    if (start < region.start) high = middle - 1;
    else if (start >= region.end) low = middle + 1;
    else return end <= region.end ? region : undefined;
  }
  return undefined;
}

function sameNativeLocations(
  left: readonly unknown[] | undefined,
  right: readonly CanonicalRegion['location'][]
): boolean {
  return left === undefined || (
    left.length === right.length
    && left.every((location, index) => isNativeLocationV3(location)
      && nativeLocationIdentity(location) === nativeLocationIdentity(right[index] as CanonicalRegion['location']))
  );
}

function bindNativeLocations(
  detected: readonly DetectionEvidence[],
  sourceRegions: readonly CanonicalRegion[] | undefined,
  textLength: number,
  requestCorrelationId: CorrelationId
): readonly DetectionEvidence[] {
  if (sourceRegions === undefined) return detected;
  const regions = validatedRegions(sourceRegions, textLength, requestCorrelationId);
  return Object.freeze(detected.map((item) => {
    const region = regionForSpan(regions, item.span.start, item.span.end);
    if (region === undefined) return sourceMapInvalid(requestCorrelationId);
    const nativeLocations = Object.freeze([region.location]);
    if (!sameNativeLocations(item.nativeLocations, nativeLocations)) return sourceMapInvalid(requestCorrelationId);
    return Object.freeze({ ...item, nativeLocations });
  }));
}

async function scanArtifact(
  dependencies: TextProcessingApplicationDependencies,
  command: TextCommand,
  requestCorrelationId: CorrelationId
): Promise<TextScanResult> {
  const artifact = await command.session.input(command.signal);
  const policy = 'policy' in command ? command.policy : undefined;
  const structure = policy?.structure;
  const hasStructuredRules = (structure?.json.rules.length ?? 0) > 0
    || (structure?.csv.columns.length ?? 0) > 0;
  if (hasStructuredRules && artifact.regions === undefined) {
    throw new SafeError({
      code: 'POLICY_UNSATISFIABLE',
      message: 'The structured policy cannot be applied to this artifact.',
      retryable: false,
      correlationId: requestCorrelationId
    });
  }
  let detected: readonly DetectionEvidence[];
  if (hasStructuredRules) {
    if (dependencies.detector.detectStructured === undefined || structure === undefined) {
      throw new SafeError({
        code: 'POLICY_UNSATISFIABLE',
        message: 'The configured detector cannot apply structured policy rules.',
        retryable: false,
        correlationId: requestCorrelationId
      });
    }
    detected = await dependencies.detector.detectStructured({
      text: artifact.text,
      extractionRevision: artifact.extractionRevision,
      regions: artifact.regions as readonly CanonicalRegionV1[],
      structure
    }, command.signal);
  } else {
    detected = await dependencies.detector.detect(
      artifact.text,
      artifact.extractionRevision,
      command.signal
    );
  }
  const evidence = bindNativeLocations(
    detected,
    artifact.regions,
    unicodeCodePointLength(artifact.text),
    requestCorrelationId
  );
  const resolution = resolveEvidence(
    evidence,
    artifact.extractionRevision,
    unicodeCodePointLength(artifact.text)
  );
  return {
    artifact,
    detectorBundleVersion: dependencies.detector.detectorBundleVersion,
    evidence,
    resolution,
    outcome: resolution.conflicts.length === 0 ? 'SUCCEEDED' : 'NEEDS_REVIEW'
  };
}

async function readAndScan(
  dependencies: TextProcessingApplicationDependencies,
  command: TextCommand,
  requestCorrelationId: CorrelationId
): Promise<TextScanResult> {
  await preflight(dependencies, command.requirement, requestCorrelationId, command.signal);
  return scanArtifact(dependencies, command, requestCorrelationId);
}

function unresolvedConflict(correlationId: CorrelationId, conflictCount: number): SafeError {
  return new SafeError({
    code: 'REDACTION_PLAN_CONFLICT',
    message: 'Overlapping detections require review before redaction.',
    retryable: false,
    correlationId,
    details: { conflictCount }
  });
}

function residualsBlocked(correlationId: CorrelationId, findingCount: number): SafeError {
  return new SafeError({
    code: 'VERIFICATION_RESIDUAL',
    message: 'Residual sensitive content blocked publication of the derived artifact.',
    retryable: false,
    correlationId,
    details: { findingCount }
  });
}

function verificationIncomplete(correlationId: CorrelationId): SafeError {
  return new SafeError({
    code: 'VERIFICATION_INCOMPLETE',
    message: 'The required verification profile did not complete with a valid report.',
    retryable: false,
    correlationId
  });
}

function redactionCountMismatch(correlationId: CorrelationId): SafeError {
  return new SafeError({
    code: 'REDACTION_COUNT_MISMATCH',
    message: 'The writer did not apply the exact redaction plan actions.',
    retryable: false,
    correlationId
  });
}

function assertWriterReceipt(
  receipt: WriterReceipt,
  plan: Awaited<ReturnType<typeof compileTypedLabelPlan>>,
  staged: Readonly<{ readonly digest: string; readonly byteLength: number }>,
  correlationId: CorrelationId
): void {
  try {
    assertContract(writerReceiptSchemaId, receipt);
    const { receiptDigest, ...unsigned } = receipt;
    if (
      parseSha256Digest(receiptDigest) !== computeWriterReceiptDigest(unsigned)
      || parseSha256Digest(receipt.planDigest) !== plan.digest
      || parseSha256Digest(receipt.stagedDigest) !== staged.digest
      || receipt.stagedByteLength !== staged.byteLength
      || receipt.writer.id !== plan.writer.id
      || receipt.writer.version !== plan.writer.version
    ) {
      throw new Error('writer receipt binding mismatch');
    }
  } catch {
    throw verificationIncomplete(correlationId);
  }

  const expectedActionIds = plan.actions.map(({ id }) => id);
  if (
    receipt.expectedActionCount !== plan.expectedActionCount
    || receipt.appliedActionCount !== receipt.appliedActionIds.length
    || receipt.appliedActionCount !== expectedActionIds.length
    || receipt.appliedActionIds.some((id, index) => id !== expectedActionIds[index])
  ) {
    throw redactionCountMismatch(correlationId);
  }
}

function policyDecisionBlocked(
  correlationId: CorrelationId,
  code: 'POLICY_REVIEW_REQUIRED' | 'POLICY_BLOCKED'
): SafeError {
  return new SafeError({
    code,
    message: code === 'POLICY_REVIEW_REQUIRED'
      ? 'The selected policy requires review before redaction can continue.'
      : 'The selected policy blocked automatic redaction.',
    retryable: false,
    correlationId
  });
}

function assertWriterMatchesCapability(
  command: RedactTextCommand,
  manifest: CapabilityManifest,
  correlationId: CorrelationId
): void {
  const format = manifest.formats.find(({ id }) => id === command.requirement.formatId);
  if (
    format?.adapter !== command.session.writer.id
    || format.version !== command.session.writer.version
  ) {
    throw new SafeError({
      code: 'POLICY_UNSATISFIABLE',
      message: 'The selected writer does not match the preflighted format capability.',
      retryable: false,
      correlationId,
      details: { reason: 'writer_capability_mismatch' }
    });
  }
}

function stagedBytesChanged(correlationId: CorrelationId): SafeError {
  return new SafeError({
    code: 'ARTIFACT_DIGEST_MISMATCH',
    message: 'The staged artifact changed before verification.',
    retryable: false,
    correlationId
  });
}

function assertVerificationAttestation(
  report: TextVerificationAttestation,
  request: BoundTextVerificationRequest,
  dependencies: TextProcessingApplicationDependencies,
  manifest: CapabilityManifest,
  expectedProfileId: string,
  correlationId: CorrelationId
): void {
  const capabilityProfile = manifest.verificationProfiles.find(({ id }) =>
    id === expectedProfileId
  );
  try {
    assertContract(verificationAttestationSchemaId, report);
    const { reportDigest, ...unsigned } = report;
    const expectedChecks = [...new Set([
      ...(capabilityProfile?.checks ?? []),
      'ACTION_RECONCILIATION'
    ])];
    const bindingsMatch = capabilityProfile !== undefined
      && dependencies.verifier.attestation.profile.id === expectedProfileId
      && dependencies.verifier.attestation.profile.version === capabilityProfile.version
      && reportDigest === computeVerificationAttestationDigest(unsigned)
      && report.input.digest === request.input.digest
      && report.input.byteLength === request.input.byteLength
      && report.output.digest === request.output.digest
      && report.output.byteLength === request.output.byteLength
      && report.output.mediaType === request.output.mediaType
      && report.output.extractionRevision === request.output.extractionRevision
      && report.plan.id === request.plan.id
      && report.plan.digest === request.plan.digest
      && report.policy.id === request.policy.id
      && report.policy.version === request.policy.version
      && report.policy.digest === request.policy.digest
      && report.policy.riskTier === request.policy.riskTier
      && report.capabilityDigest === request.capabilityDigest
      && report.writerReceiptDigest === request.writerReceipt.receiptDigest
      && report.profile.id === dependencies.verifier.attestation.profile.id
      && report.profile.version === dependencies.verifier.attestation.profile.version
      && report.profile.digest === dependencies.verifier.attestation.profile.digest
      && report.verifier.id === dependencies.verifier.attestation.verifier.id
      && report.verifier.version === dependencies.verifier.attestation.verifier.version
      && report.verifier.digest === dependencies.verifier.attestation.verifier.digest
      && report.detectorBundle.id === dependencies.verifier.attestation.detectorBundle.id
      && report.detectorBundle.version === dependencies.verifier.attestation.detectorBundle.version
      && report.detectorBundle.digest === dependencies.verifier.attestation.detectorBundle.digest
      && report.writer.id === request.writer.id
      && report.writer.version === request.writer.version
      && report.writer.digest === request.writer.digest
      && report.application.id === dependencies.verifier.attestation.application.id
      && report.application.version === dependencies.verifier.attestation.application.version
      && report.application.digest === dependencies.verifier.attestation.application.digest
      && expectedChecks.length === report.checks.length
      && expectedChecks.every((check, index) => report.checks[index] === check)
      && Date.parse(report.completedAt) >= Date.parse(report.startedAt);
    const incompleteFindingCodes = new Set([
      'REOPEN_FAILED',
      'OUTPUT_DIGEST_MISMATCH',
      'VERIFIER_INCOMPLETE'
    ]);
    const hasIncompleteFinding = report.findings.some(({ code }) => incompleteFindingCodes.has(code));
    const outcomeIsCoherent = report.outcome === 'PASS'
      ? report.findings.length === 0
      : report.outcome === 'INCOMPLETE'
        ? report.findings.length > 0 && hasIncompleteFinding
        : report.findings.length > 0 && !hasIncompleteFinding;
    if (!bindingsMatch || !outcomeIsCoherent) {
      throw new Error('verification attestation binding or outcome mismatch');
    }
  } catch {
    throw verificationIncomplete(correlationId);
  }

  const reconciliation = report.reconciliation;
  if (
    reconciliation.expectedActionCount !== request.plan.expectedActionCount
    || reconciliation.appliedActionCount !== request.writerReceipt.appliedActionCount
    || reconciliation.missingActionCount !== 0
    || reconciliation.unexpectedActionCount !== 0
    || reconciliation.duplicateActionCount !== 0
  ) {
    throw redactionCountMismatch(correlationId);
  }

  if (report.outcome === 'INCOMPLETE') throw verificationIncomplete(correlationId);
  if (report.outcome !== 'PASS') {
    throw residualsBlocked(correlationId, report.findings.length);
  }
}

async function discardAfterFailure(
  command: RedactTextCommand,
  staged: Awaited<ReturnType<RedactTextCommand['session']['stage']>>,
  processingError: unknown,
  correlationId: CorrelationId
): Promise<void> {
  if (
    processingError instanceof SafeError
    && processingError.code === 'STORAGE_UNAVAILABLE'
    && processingError.details?.reason === 'stage_cleanup_failed_after_publication'
  ) {
    // The adapter already exhausted ownership-aware cleanup after the commit
    // barrier. A blind second unlink could remove a concurrently replaced path.
    throw processingError;
  }
  try {
    // Cleanup must remain possible after a caller has cancelled the work itself.
    await command.session.discard(staged);
  } catch {
    throw new SafeError({
      code: 'STORAGE_UNAVAILABLE',
      message: 'The derived artifact could not be safely discarded after processing failed.',
      retryable: true,
      correlationId,
      details: {
        reason: `cleanup_failed_after_${processingError instanceof SafeError ? processingError.code : 'INTERNAL_ERROR'}`
      }
    });
  }
}

export function createTextProcessingApplication(
  dependencies: TextProcessingApplicationDependencies
): TextProcessingApplication {
  return Object.freeze({
    async getCapabilities(context: ApplicationContext, signal?: AbortSignal): Promise<CapabilityManifest> {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, signal, async () => {
        const manifest = await dependencies.capabilityProvider.getCapabilities(signal);
        assertCapabilityManifest(manifest, requestCorrelationId);
        return manifest;
      });
    },

    async inspect(command: TextCommand, context: ApplicationContext) {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, command.signal, async () => {
        await preflight(dependencies, command.requirement, requestCorrelationId, command.signal);
        return { artifact: await command.session.input(command.signal) };
      });
    },

    async scan(command: TextCommand, context: ApplicationContext) {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, command.signal, () => readAndScan(dependencies, command, requestCorrelationId));
    },

    async verify(command: TextCommand, context: ApplicationContext) {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, command.signal, async () => {
        await preflight(dependencies, command.requirement, requestCorrelationId, command.signal);
        const artifact = await command.session.input(command.signal);
        return {
          artifact,
          verification: await dependencies.verifier.verify(
            artifact.text,
            artifact.extractionRevision,
            command.signal
          )
        };
      });
    },

    async redact(command: RedactTextCommand, context: ApplicationContext) {
      const requestCorrelationId = correlationId(context);
      return invoke(requestCorrelationId, command.signal, async () => {
        const manifest = await preflight(
          dependencies,
          command.requirement,
          requestCorrelationId,
          command.signal
        );
        const policyRequirement = compileCapabilityRequirement(command.policy, {
          contractVersion: command.requirement.contractVersion,
          engineModes: command.requirement.engineModes,
          formatId: command.requirement.formatId,
          operation: command.requirement.operation,
          minimumQualification: command.requirement.minimumQualification
        });
        assertCapabilities(policyRequirement, manifest, requestCorrelationId);
        assertWriterMatchesCapability(command, manifest, requestCorrelationId);
        const capabilityDigest = digestCapabilityManifest(manifest, requestCorrelationId);

        const scanned = await scanArtifact(dependencies, command, requestCorrelationId);
        if (scanned.resolution.conflicts.length > 0) {
          throw unresolvedConflict(requestCorrelationId, scanned.resolution.conflicts.length);
        }

        const reviewDecisions = validatedReviewDecisions(
          command,
          scanned.resolution.extractionRevision,
          new Set(scanned.resolution.spans.map(({ id }) => id)),
          requestCorrelationId
        );
        const reviewedSpans = scanned.resolution.spans.map((span) => {
          const review = reviewDecisions.get(span.id);
          return review?.action === 'RETYPE' ? { ...span, entityType: review.entityType } : span;
        });
        const policyDecisions = reviewedSpans.map((span) => {
          const review = reviewDecisions.get(span.id);
          if (review?.action === 'REJECT') {
            return {
              spanId: span.id,
              evidenceIds: [...span.evidenceIds],
              entityType: span.entityType,
              action: 'KEEP' as const,
              explanationCode: 'REVIEW_REJECTED' as const,
              reviewAction: review.action
            };
          }
          const decision = review === undefined
            ? evaluateAcceptedSpan(command.policy, {
              ...span,
              extractionRevision: scanned.resolution.extractionRevision
            }, scanned.evidence)
            : evaluateReviewedEntity(
              command.policy,
              span.entityType,
              review.action === 'RETYPE' ? 'REVIEW_RETYPED' : 'REVIEW_ACCEPTED'
            );
          return {
            spanId: span.id,
            evidenceIds: [...span.evidenceIds],
            ...decision,
            ...(review === undefined ? {} : { reviewAction: review.action })
          };
        });
        if (policyDecisions.some(({ action }) => action === 'BLOCK')) {
          throw policyDecisionBlocked(requestCorrelationId, 'POLICY_BLOCKED');
        }
        if (policyDecisions.some(({ action }) => action === 'REQUIRE_REVIEW')) {
          throw policyDecisionBlocked(requestCorrelationId, 'POLICY_REVIEW_REQUIRED');
        }
        const approvedSpanIds = new Set(policyDecisions
          .filter(({ action }) => action === 'TYPED_LABEL')
          .map(({ spanId }) => spanId));
        const approvedResolution = {
          ...scanned.resolution,
          spans: reviewedSpans.filter(({ id }) => approvedSpanIds.has(id))
        };
        const spansById = new Map(scanned.resolution.spans.map((span) => [span.id, span] as const));
        const planReview = command.review === undefined ? undefined : {
          ...command.review.binding,
          decisions: [...reviewDecisions.values()]
            .map((decision) => {
              const span = spansById.get(decision.sourceSpanId);
              if (span === undefined) throw reviewPlanConflict(requestCorrelationId);
              const common = {
                sourceSpanId: span.id,
                entityType: span.entityType,
                start: span.start,
                end: span.end
              };
              return decision.action === 'RETYPE'
                ? { ...common, action: decision.action, reviewedEntityType: decision.entityType }
                : { ...common, action: decision.action };
            })
            .sort((left, right) => left.start - right.start || left.sourceSpanId.localeCompare(right.sourceSpanId))
        } as const;
        const policy = {
          id: command.policy.id,
          version: command.policy.version,
          digest: command.policy.digest,
          riskTier: command.policy.riskTier
        } as const;
        const plan = compileTypedLabelPlan(approvedResolution, {
          inputDigest: scanned.artifact.digest,
          capabilityDigest,
          detectorBundleVersion: scanned.detectorBundleVersion,
          policy,
          writer: command.session.writer,
          ...(planReview === undefined ? {} : { review: planReview })
        });
        assertContract(redactionPlanSchemaIds[plan.schemaVersion], plan);
        let staged: Awaited<ReturnType<RedactTextCommand['session']['stage']>> | undefined;
        try {
          staged = await command.session.stage(plan, command.signal);
          assertWriterReceipt(staged.receipt, plan, staged, requestCorrelationId);
          const reopened = await command.session.reopen(staged, command.signal);
          if (reopened.digest !== staged.digest || reopened.byteLength !== staged.byteLength) {
            throw stagedBytesChanged(requestCorrelationId);
          }
          const verificationRequest: BoundTextVerificationRequest = {
            reopenedText: reopened.text,
            input: {
              digest: scanned.artifact.digest,
              byteLength: scanned.artifact.byteLength
            },
            output: {
              digest: reopened.digest,
              byteLength: reopened.byteLength,
              mediaType: reopened.mediaType,
              extractionRevision: reopened.extractionRevision
            },
            capabilityDigest,
            plan,
            policy,
            writerReceipt: staged.receipt,
            writer: command.session.writer,
            application: dependencies.verifier.attestation.application
          };
          let verification: TextVerificationAttestation;
          try {
            verification = await dependencies.verifier.attest(verificationRequest, command.signal);
          } catch {
            if (command.signal?.aborted === true) {
              throw new SafeError({
                code: 'OPERATION_CANCELLED',
                message: 'The operation was cancelled.',
                retryable: false,
                correlationId: requestCorrelationId
              });
            }
            throw verificationIncomplete(requestCorrelationId);
          }
          assertVerificationAttestation(
            verification,
            verificationRequest,
            dependencies,
            manifest,
            command.policy.verification.profile,
            requestCorrelationId
          );
          const published = await command.session.publish(staged, command.signal);
          if (published.digest !== staged.digest || published.byteLength !== staged.byteLength) {
            throw stagedBytesChanged(requestCorrelationId);
          }
          return {
            input: scanned.artifact,
            policy,
            policyDecisions,
            detectorBundleVersion: scanned.detectorBundleVersion,
            evidence: scanned.evidence,
            resolution: scanned.resolution,
            plan,
            writerReceipt: staged.receipt,
            verification,
            published
          };
        } catch (error: unknown) {
          if (staged !== undefined) {
            await discardAfterFailure(command, staged, error, requestCorrelationId);
          }
          throw error;
        }
      });
    }
  });
}
