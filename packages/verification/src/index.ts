import { detectDeterministic, deterministicDetectorBundleVersion } from '@local-pii/detectors';
import type { EntityType, Sha256Digest } from '@local-pii/domain';
import { unicodeCodePointLength } from '@local-pii/domain';
import { resolveEvidence } from '@local-pii/span-resolution';

export interface VerificationFinding {
  readonly code: 'RESIDUAL_DETECTION' | 'SPAN_CONFLICT';
  readonly severity: 'ERROR';
  readonly blocking: true;
  readonly entityType?: EntityType;
  readonly start?: number;
  readonly end?: number;
}

export interface TextVerificationReport {
  readonly schemaVersion: '1.0.0';
  readonly profile: 'text-rescan-v1';
  readonly outcome: 'PASS' | 'FAIL';
  readonly detectorBundleVersion: string;
  readonly checks: readonly ['UTF8_REOPEN', 'DETERMINISTIC_RESCAN', 'SPAN_RESOLUTION'];
  readonly findings: readonly VerificationFinding[];
}

export function verifyCanonicalText(text: string, extractionRevision: Sha256Digest): TextVerificationReport {
  const evidence = detectDeterministic(text, extractionRevision);
  const resolution = resolveEvidence(evidence, extractionRevision, unicodeCodePointLength(text));
  const findings: VerificationFinding[] = [
    ...resolution.spans.map((span) => ({
      code: 'RESIDUAL_DETECTION' as const,
      severity: 'ERROR' as const,
      blocking: true as const,
      entityType: span.entityType,
      start: span.start,
      end: span.end
    })),
    ...resolution.conflicts.map((conflict) => ({
      code: 'SPAN_CONFLICT' as const,
      severity: 'ERROR' as const,
      blocking: true as const,
      start: conflict.start,
      end: conflict.end
    }))
  ];
  return {
    schemaVersion: '1.0.0',
    profile: 'text-rescan-v1',
    outcome: findings.length === 0 ? 'PASS' : 'FAIL',
    detectorBundleVersion: deterministicDetectorBundleVersion,
    checks: ['UTF8_REOPEN', 'DETERMINISTIC_RESCAN', 'SPAN_RESOLUTION'],
    findings
  };
}
