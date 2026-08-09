import { describe, expect, it } from 'vitest';

import { parseSha256Digest } from '@local-pii/domain';
import { assertContract, computeVerificationAttestationDigest, computeWriterReceiptDigest } from '@local-pii/contracts';

import {
  type BoundTextVerificationRequest,
  type VerificationPlanBinding,
  type WriterReceipt,
  verifyBoundCanonicalText,
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
