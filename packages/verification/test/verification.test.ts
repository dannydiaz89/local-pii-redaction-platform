import { describe, expect, it } from 'vitest';

import { parseSha256Digest } from '@local-pii/domain';
import { assertContract, computeVerificationAttestationDigest, computeWriterReceiptDigest } from '@local-pii/contracts';

import type { DetectionEvidence } from '@local-pii/domain';

import {
  type BoundTextVerificationRequest,
  type VerificationPlanBinding,
  type WriterReceipt,
  createHybridTextVerificationDetectorBundle,
  textHybridVerificationProfile,
  verifyBoundCanonicalText,
  verifyBoundHybridText,
  verifyCanonicalText
} from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'d'.repeat(64)}`);
const inputDigest = parseSha256Digest(`sha256:${'a'.repeat(64)}`);
const outputDigest = parseSha256Digest(`sha256:${'b'.repeat(64)}`);
const planDigest = parseSha256Digest(`sha256:${'c'.repeat(64)}`);
const policyDigest = parseSha256Digest(`sha256:${'e'.repeat(64)}`);
const capabilityDigest = parseSha256Digest(`sha256:${'f'.repeat(64)}`);
const actionId = 'act_01J4M8Z7QK2C5B6TFXDA9R4M3V';
const extraActionId = 'act_01J4M8Z7QK2C5B6TFXDA9R4M3W';

const plan: VerificationPlanBinding = {
  id: 'plan_01J4M8Z7QK2C5B6TFXDA9R4M3V',
  digest: planDigest,
  inputDigest,
  extractionRevision: revision,
  capabilityDigest,
  policy: { id: 'development-labels', version: '0.1.0', digest: policyDigest, riskTier: 'LOW' },
  writer: { id: 'text-adapter', version: '0.1.0' },
  expectedActionCount: 1,
  actions: [{ id: actionId }]
};

function receipt(appliedActionIds: string[] = [actionId]): WriterReceipt {
  const unsigned = {
    schemaVersion: '1.0.0' as const,
    planDigest,
    writer: { id: 'text-adapter', version: '0.1.0' },
    stagedDigest: outputDigest,
    stagedByteLength: 17,
    expectedActionCount: 1,
    appliedActionCount: appliedActionIds.length,
    appliedActionIds
  };
  return { ...unsigned, receiptDigest: parseSha256Digest(computeWriterReceiptDigest(unsigned)) };
}

function boundRequest(reopenedText = 'Contact [EMAIL_1]'): BoundTextVerificationRequest {
  return {
    reopenedText,
    input: { digest: inputDigest, byteLength: 24 },
    output: { digest: outputDigest, byteLength: 17, mediaType: 'text/plain', extractionRevision: revision },
    capabilityDigest,
    plan,
    policy: plan.policy,
    writerReceipt: receipt(),
    writer: { id: 'text-adapter', version: '0.1.0', digest: parseSha256Digest(`sha256:${'6'.repeat(64)}`) },
    application: { id: 'local-pii-cli', version: '0.1.0', digest: parseSha256Digest(`sha256:${'7'.repeat(64)}`) },
    startedAt: '2026-08-09T00:00:00Z',
    completedAt: '2026-08-09T00:00:01Z'
  };
}

describe('text verification', () => {
  it('blocks deterministic residuals without returning their values', () => {
    const text = 'Residual alpha@example.test';
    const report = verifyCanonicalText(text, revision);
    expect(report.outcome).toBe('FAIL');
    expect(report.findings[0]?.entityType).toBe('EMAIL');
    expect(JSON.stringify(report)).not.toContain('alpha@example.test');
  });

  it('passes a typed-label output', () => {
    expect(verifyCanonicalText('Contact [EMAIL_1]', revision).outcome).toBe('PASS');
  });
});

describe('bound verification attestation', () => {
  it('returns a canonical privacy-safe PASS attestation', () => {
    const report = verifyBoundCanonicalText(boundRequest());
    const { reportDigest, ...unsigned } = report;
    expect(report.outcome).toBe('PASS');
    expect(report.reconciliation).toEqual({
      expectedActionCount: 1,
      appliedActionCount: 1,
      missingActionCount: 0,
      unexpectedActionCount: 0,
      duplicateActionCount: 0
    });
    expect(reportDigest).toBe(computeVerificationAttestationDigest(unsigned));
    expect(() => {
      assertContract('https://local-pii.dev/schemas/verification/verification-report/2.0.0', report);
    }).not.toThrow();
    expect(JSON.stringify(report)).not.toContain('Contact');
    expect(JSON.stringify(report)).not.toContain('EMAIL_1');
    expect(JSON.stringify(report)).not.toContain(actionId);
  });

  it('fails for a residual without returning the residual value', () => {
    const report = verifyBoundCanonicalText(boundRequest('Residual alpha@example.test'));
    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'RESIDUAL_ENTITY', entityType: 'EMAIL', count: 1
    }));
    expect(JSON.stringify(report)).not.toContain('alpha@example.test');
  });

  it('permits only an exact rejected-review residual at its mapped output span', () => {
    const reviewedPlan: VerificationPlanBinding = {
      ...plan,
      actions: [{
        id: actionId,
        sourceSpanId: 'rsp_11111111111141118111111111111111',
        entityType: 'EMAIL',
        start: 0,
        end: 13,
        replacement: '[EMAIL_1]'
      }],
      review: {
        extractionRevision: revision,
        revision: 2,
        decisionCount: 2,
        digest: parseSha256Digest(`sha256:${'8'.repeat(64)}`),
        decisions: [{
          sourceSpanId: 'rsp_11111111111141118111111111111111',
          action: 'ACCEPT',
          entityType: 'EMAIL',
          start: 0,
          end: 13
        }, {
          sourceSpanId: 'rsp_22222222222242228222222222222222',
          action: 'REJECT',
          entityType: 'PHONE',
          start: 14,
          end: 26
        }]
      }
    };
    const request = { ...boundRequest('[EMAIL_1] 555-123-4567'), plan: reviewedPlan };

    expect(verifyBoundCanonicalText(request).outcome).toBe('PASS');
    const shifted = verifyBoundCanonicalText({ ...request, reopenedText: 'x[EMAIL_1] 555-123-4567' });
    expect(shifted.outcome).toBe('FAIL');
    expect(shifted.findings).toContainEqual(expect.objectContaining({
      code: 'RESIDUAL_ENTITY', entityType: 'PHONE', count: 1
    }));
  });

  it.each([
    ['missing', receipt([]), 'ACTION_NOT_APPLIED'],
    ['extra', receipt([actionId, extraActionId]), 'UNEXPECTED_ACTION'],
    ['duplicate', receipt([actionId, actionId]), 'DUPLICATE_ACTION']
  ])('fails for %s receipt action IDs', (_kind, writerReceipt, code) => {
    const report = verifyBoundCanonicalText({ ...boundRequest(), writerReceipt });
    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({ code }));
    expect(JSON.stringify(report)).not.toContain(actionId);
    expect(JSON.stringify(report)).not.toContain(extraActionId);
  });

  it.each([
    ['output', (request: BoundTextVerificationRequest) => ({
      ...request,
      output: { ...request.output, digest: parseSha256Digest(`sha256:${'1'.repeat(64)}`) }
    })],
    ['plan', (request: BoundTextVerificationRequest) => ({
      ...request,
      plan: { ...request.plan, digest: parseSha256Digest(`sha256:${'2'.repeat(64)}`) }
    })],
    ['policy', (request: BoundTextVerificationRequest) => ({
      ...request,
      policy: { ...request.policy, digest: parseSha256Digest(`sha256:${'3'.repeat(64)}`) }
    })],
    ['receipt', (request: BoundTextVerificationRequest) => ({
      ...request,
      writerReceipt: { ...request.writerReceipt, receiptDigest: parseSha256Digest(`sha256:${'4'.repeat(64)}`) }
    })]
  ])('marks a wrong %s digest as incomplete', (_kind, alter) => {
    expect(verifyBoundCanonicalText(alter(boundRequest())).outcome).toBe('INCOMPLETE');
  });

  it('marks malformed bindings as incomplete without exposing text', () => {
    const request = boundRequest('Do not expose this value');
    const report = verifyBoundCanonicalText({ ...request, completedAt: 'not-a-time' });
    expect(report.outcome).toBe('INCOMPLETE');
    expect(JSON.stringify(report)).not.toContain('Do not expose this value');
  });

  it('marks reversed attestation timestamps as incomplete', () => {
    const request = boundRequest();
    expect(verifyBoundCanonicalText({
      ...request,
      startedAt: '2026-08-09T00:00:02Z',
      completedAt: '2026-08-09T00:00:01Z'
    }).outcome).toBe('INCOMPLETE');
  });
});

describe('hybrid verification attestation', () => {
  const contextualVersion = `0.1.0-ollama-experimental.3.sha256-${'a'.repeat(64)}`;
  const detectorBundle = createHybridTextVerificationDetectorBundle(contextualVersion);
  const schemaId = 'https://local-pii.dev/schemas/verification/verification-report/2.0.0';

  function modelEvidence(entityType: DetectionEvidence['entityType'], start: number, end: number): DetectionEvidence {
    return {
      id: '3f4b2c1d-9e8a-5b7c-8d6e-1f2a3b4c5d6e',
      entityType,
      source: 'MODEL',
      confidence: 0.5,
      detector: { id: 'ollama-local-model', version: contextualVersion, ruleId: 'model-000000000000000000000000' },
      span: { start, end, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision: revision }
    } as unknown as DetectionEvidence;
  }

  it('binds the model digest into the detector bundle without exposing the version string', () => {
    const other = createHybridTextVerificationDetectorBundle(`0.1.0-ollama-experimental.3.sha256-${'b'.repeat(64)}`);
    expect(detectorBundle.id).toBe('hybrid-text');
    expect(detectorBundle.version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(detectorBundle.digest).not.toBe(other.digest);
    expect(createHybridTextVerificationDetectorBundle(contextualVersion).digest).toBe(detectorBundle.digest);
  });

  it('passes when the deterministic and contextual rescans both find nothing', async () => {
    const seen: string[] = [];
    const report = await verifyBoundHybridText(boundRequest(), {
      detectorBundle,
      contextualRescan: (text) => {
        seen.push(text);
        return Promise.resolve([]);
      },
      completedAt: () => '2026-08-09T00:00:02Z'
    });
    assertContract(schemaId, report);
    expect(seen).toEqual(['Contact [EMAIL_1]']);
    expect(report.outcome).toBe('PASS');
    expect(report.findings).toEqual([]);
    expect(report.checks).toEqual(['UTF8_REOPEN', 'DETERMINISTIC_RESCAN', 'CONTEXTUAL_RESCAN', 'SPAN_RESOLUTION', 'ACTION_RECONCILIATION']);
    expect(report.profile).toEqual(textHybridVerificationProfile);
    expect(report.detectorBundle).toEqual(detectorBundle);
    expect(report.completedAt).toBe('2026-08-09T00:00:02Z');
    const { reportDigest, ...unsigned } = report;
    expect(reportDigest).toBe(computeVerificationAttestationDigest(unsigned));
  });

  it('fails on anchored model residuals as counts without returning spans or values', async () => {
    const report = await verifyBoundHybridText(boundRequest(), {
      detectorBundle,
      contextualRescan: () => Promise.resolve([modelEvidence('PERSON', 0, 7), modelEvidence('PERSON', 8, 17)])
    });
    assertContract(schemaId, report);
    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toEqual([
      { code: 'RESIDUAL_ENTITY', severity: 'ERROR', blocking: true, check: 'CONTEXTUAL_RESCAN', entityType: 'PERSON', count: 2 }
    ]);
    expect(JSON.stringify(report)).not.toContain('"start"');
    expect(JSON.stringify(report)).not.toContain('Contact');
  });

  it('does not count model spans that lie inside a typed-label replacement the plan wrote', async () => {
    // Input 'Contact alpha@x.y' (17 code points) → action [8,17) replaced by '[EMAIL_1]' (9) → output [8,17).
    const labelledPlan: VerificationPlanBinding = {
      ...plan,
      actions: [{ id: actionId, start: 8, end: 17, replacement: '[EMAIL_1]' }]
    };
    const request = { ...boundRequest(), plan: labelledPlan };
    const inside = await verifyBoundHybridText(request, {
      detectorBundle,
      contextualRescan: () => Promise.resolve([modelEvidence('PERSON', 8, 17), modelEvidence('PERSON', 9, 16)])
    });
    expect(inside.outcome).toBe('PASS');

    const spilling = await verifyBoundHybridText(request, {
      detectorBundle,
      contextualRescan: () => Promise.resolve([modelEvidence('PERSON', 7, 17)])
    });
    expect(spilling.outcome).toBe('FAIL');
    expect(spilling.findings).toEqual([
      { code: 'RESIDUAL_ENTITY', severity: 'ERROR', blocking: true, check: 'CONTEXTUAL_RESCAN', entityType: 'PERSON', count: 1 }
    ]);
  });

  it('ignores non-model evidence from the rescan so deterministic residuals are not double counted', async () => {
    const report = await verifyBoundHybridText(boundRequest(), {
      detectorBundle,
      contextualRescan: () => Promise.resolve([{ ...modelEvidence('EMAIL', 0, 7), source: 'RULE' } as unknown as DetectionEvidence])
    });
    expect(report.outcome).toBe('PASS');
  });

  it('is incomplete rather than passing when the model cannot be consulted', async () => {
    const report = await verifyBoundHybridText(boundRequest(), {
      detectorBundle,
      contextualRescan: () => Promise.reject(new Error('model unavailable'))
    });
    assertContract(schemaId, report);
    expect(report.outcome).toBe('INCOMPLETE');
    expect(report.findings).toEqual([
      { code: 'VERIFIER_INCOMPLETE', severity: 'ERROR', blocking: true, check: 'CONTEXTUAL_RESCAN' }
    ]);
    expect(JSON.stringify(report)).not.toContain('model unavailable');
  });

  it('is incomplete when the rescan returns an out-of-range span instead of trusting it', async () => {
    const report = await verifyBoundHybridText(boundRequest(), {
      detectorBundle,
      contextualRescan: () => Promise.resolve([modelEvidence('PERSON', 0, 999)])
    });
    expect(report.outcome).toBe('INCOMPLETE');
    expect(report.findings.map(({ check }) => check)).toEqual(['CONTEXTUAL_RESCAN']);
  });

  it('propagates cancellation instead of recording it as a verification outcome', async () => {
    const controller = new AbortController();
    await expect(verifyBoundHybridText(boundRequest(), {
      detectorBundle,
      signal: controller.signal,
      contextualRescan: () => {
        controller.abort();
        return Promise.resolve([]);
      }
    })).rejects.toThrow();
  });

  it('does not consult the model when the deterministic stage is already incomplete', async () => {
    let consulted = 0;
    const report = await verifyBoundHybridText(
      { ...boundRequest(), completedAt: '2026-08-08T00:00:00Z' },
      {
        detectorBundle,
        contextualRescan: () => {
          consulted += 1;
          return Promise.resolve([]);
        }
      }
    );
    expect(report.outcome).toBe('INCOMPLETE');
    expect(consulted).toBe(0);
  });
});
