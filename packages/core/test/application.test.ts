import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import {
  computeVerificationAttestationDigest,
  computeWriterReceiptDigest,
  type UnsignedWriterReceipt
} from '@local-pii/contracts';

import {
  SafeError,
  parseDetectionId,
  parseSha256Digest,
  type DetectionEvidence,
  type Sha256Digest
} from '@local-pii/domain';

import {
  createTextProcessingApplication,
  digestCapabilityManifest,
  type BoundTextVerificationRequest,
  type CapabilityManifest,
  type CapabilityRequirement,
  type StagedTextArtifact,
  type TextArtifact,
  type TextProcessingApplicationDependencies,
  type TextProcessingSession,
  type TextVerificationAttestation,
  type TextVerificationPort,
  type TextVerificationReport
} from '../src/index.js';
import { compilePolicy, developmentLabelsPolicy, highRiskDisclosurePolicy } from '@local-pii/policy';
import { applyTypedLabelPlan, type TypedLabelPlan } from '@local-pii/redaction';

const context = { correlationId: 'cor_core_application_001' };
const policy = compilePolicy(developmentLabelsPolicy);
const structuredPolicy = compilePolicy({
  schemaVersion: '2.0.0',
  id: 'structured-development',
  version: '0.1.0',
  riskTier: 'LOW',
  defaults: {
    action: 'TYPED_LABEL', minimumConfidence: 0.8, uncertainBehavior: 'REQUIRE_REVIEW'
  },
  entities: {
    EMAIL: {
      action: 'TYPED_LABEL', minimumConfidence: 0.8, uncertainBehavior: 'REQUIRE_REVIEW'
    }
  },
  verification: { profile: 'text-rescan-v1', blockOnWarnings: true },
  limits: { maximumInputBytes: 1_048_576 },
  structure: {
    json: {
      defaultMode: 'FREE_TEXT',
      rules: [{ id: 'email-value', pointer: '/email', mode: 'STRUCTURED', entityType: 'EMAIL' }]
    }
  }
});
const digest = (value: string): Sha256Digest => parseSha256Digest(`sha256:${createHash('sha256').update(value).digest('hex')}`);
const revision = (value: string): Sha256Digest => digest(`canonical:${value}`);

function canonicalReceiptDigest(value: UnsignedWriterReceipt): Sha256Digest {
  return parseSha256Digest(computeWriterReceiptDigest(value));
}

function manifest(): CapabilityManifest {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../fixtures/contracts/valid/capability-rules-only-text.json'), 'utf8')) as CapabilityManifest;
}

const requirement: CapabilityRequirement = {
  contractVersion: '1.0.0', engineModes: ['RULES_ONLY'], formatId: 'text', operation: 'REDACT',
  detectorIds: ['email-pattern'], detectorKinds: ['REGEX'], transformationActions: ['TYPED_LABEL'],
  verificationProfile: 'text-rescan-v1', maximumInputBytes: 1_048_576, minimumQualification: 'DEVELOPMENT'
};

function artifact(reference: string, text: string): TextArtifact {
  return {
    reference, displayName: 'input.txt', mediaType: 'text/plain', byteLength: Buffer.byteLength(text),
    digest: digest(text), extractionRevision: revision(text), text, hasUtf8Bom: false
  };
}

const passingVerification: TextVerificationReport = {
  schemaVersion: '1.0.0', profile: 'text-rescan-v1', outcome: 'PASS',
  detectorBundleVersion: 'test-verifier', checks: ['TEST'], findings: []
};

const attestationDescriptor = {
  profile: { id: 'text-rescan-v1', version: '0.1.0', digest: digest('test-profile') },
  verifier: { id: 'text-verifier', version: '0.1.0', digest: digest('test-verifier') },
  detectorBundle: { id: 'test-detector-bundle', version: '0.1.0', digest: digest('test-detector') },
  application: { id: 'test-application', version: '0.1.0', digest: digest('test-application') }
} as const;

function attestationFor(
  request: BoundTextVerificationRequest,
  changes: Partial<Omit<TextVerificationAttestation, 'reportDigest'>> = {}
): TextVerificationAttestation {
  const unsigned = {
    schemaVersion: '2.0.0' as const,
    input: { ...request.input },
    output: { ...request.output },
    plan: { id: request.plan.id, digest: request.plan.digest },
    policy: { ...request.policy },
    capabilityDigest: request.capabilityDigest,
    writerReceiptDigest: request.writerReceipt.receiptDigest,
    profile: { ...attestationDescriptor.profile },
    verifier: { ...attestationDescriptor.verifier },
    detectorBundle: { ...attestationDescriptor.detectorBundle },
    writer: { ...request.writer },
    application: { ...attestationDescriptor.application },
    outcome: 'PASS' as const,
    checks: [
      'UTF8_REOPEN',
      'DETERMINISTIC_RESCAN',
      'SPAN_RESOLUTION',
      'ACTION_RECONCILIATION'
    ] as TextVerificationAttestation['checks'],
    reconciliation: {
      expectedActionCount: request.plan.expectedActionCount,
      appliedActionCount: request.writerReceipt.appliedActionCount,
      missingActionCount: 0,
      unexpectedActionCount: 0,
      duplicateActionCount: 0
    },
    findings: [],
    startedAt: '2026-08-09T07:00:00Z',
    completedAt: '2026-08-09T07:00:01Z',
    ...changes
  };
  return {
    ...unsigned,
    reportDigest: computeVerificationAttestationDigest(unsigned)
  };
}

function verifierPort(overrides: Partial<TextVerificationPort> = {}): TextVerificationPort {
  return {
    attestation: attestationDescriptor,
    verify: () => Promise.resolve(passingVerification),
    attest: (request) => Promise.resolve(attestationFor(request)),
    ...overrides
  };
}

function emailEvidence(text: string, extractionRevision: Sha256Digest): readonly DetectionEvidence[] {
  const start = text.indexOf('ada@example.test');
  if (start < 0) return [];
  return [{
    id: parseDetectionId('11111111-1111-4111-8111-111111111111'), entityType: 'EMAIL',
    span: { start, end: start + 'ada@example.test'.length, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision },
    confidence: 1, source: 'REGEX', detector: { id: 'email-pattern', version: 'test' }
  }];
}

class FakeSession implements TextProcessingSession {
  readonly writer = {
    id: 'text-adapter', version: '0.1.0', digest: digest('test-writer')
  } as const;
  readonly events: string[] = [];
  private stagedText: string | undefined;
  private readonly source: TextArtifact;

  constructor(kind: 'ephemeral' | 'durable', text = 'Email ada@example.test') {
    this.source = artifact(`${kind}://input`, text);
  }
  input(signal?: AbortSignal): Promise<TextArtifact> {
    this.events.push(`input:${String(signal?.aborted ?? false)}`);
    return Promise.resolve(this.source);
  }
  stage(plan: TypedLabelPlan, signal?: AbortSignal): Promise<StagedTextArtifact> {
    this.events.push(`stage:${String(signal?.aborted ?? false)}`);
    const text = applyTypedLabelPlan(this.source.text, plan);
    this.stagedText = text;
    const byteLength = Buffer.byteLength(text);
    const stagedDigest = digest(text);
    const unsignedReceipt = {
      schemaVersion: '1.0.0' as const,
      planDigest: plan.digest,
      writer: { id: this.writer.id, version: this.writer.version },
      stagedDigest,
      stagedByteLength: byteLength,
      expectedActionCount: plan.expectedActionCount,
      appliedActionCount: plan.actions.length,
      appliedActionIds: plan.actions.map(({ id }) => id)
    };
    return Promise.resolve({
      reference: 'stage://pending',
      byteLength,
      digest: stagedDigest,
      receipt: { ...unsignedReceipt, receiptDigest: canonicalReceiptDigest(unsignedReceipt) }
    });
  }
  reopen(staged: StagedTextArtifact, signal?: AbortSignal): Promise<TextArtifact> {
    this.events.push(`reopen:${String(signal?.aborted ??false)}`);
    return Promise.resolve(artifact(staged.reference, this.stagedText ?? ''));
  }
  publish(staged: StagedTextArtifact, signal?: AbortSignal) {
    this.events.push(`publish:${String(signal?.aborted ?? false)}`);
    return Promise.resolve({ reference: `published://${staged.reference}`, byteLength: staged.byteLength, digest: staged.digest });
  }
  discard(_staged: StagedTextArtifact, signal?: AbortSignal): Promise<void> {
    this.events.push(`discard:${String(signal?.aborted ?? false)}`);
    this.stagedText = undefined;
    return Promise.resolve();
  }
}

function dependencies(overrides: Partial<TextProcessingApplicationDependencies> = {}): TextProcessingApplicationDependencies {
  return {
    capabilityProvider: { getCapabilities: () => Promise.resolve(manifest()) },
    detector: { detectorBundleVersion: 'test-detector', detect: (text, extractionRevision) => Promise.resolve(emailEvidence(text, extractionRevision)) },
    verifier: verifierPort(),
    ...overrides
  };
}

describe('TextProcessingApplication', () => {
  it('preflights before reading input and is framework agnostic', async () => {
    const events: string[] = [];
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      capabilityProvider: { getCapabilities: () => { events.push('preflight'); return Promise.resolve(manifest()); } }
    }));
    const originalInput = session.input.bind(session);
    session.input = async (signal) => { events.push('input'); return originalInput(signal); };
    await app.scan({ session, requirement: { ...requirement, operation: 'SCAN' } }, context);
    expect(events).toEqual(['preflight', 'input']);
    expect(Object.isFrozen(app)).toBe(true);
  });

  it('binds a structured detection to the adapter-owned typed native region', async () => {
    const sourceText = 'Email ada@example.test';
    const source = {
      ...artifact('structured://input', sourceText),
      regions: [{
        schemaVersion: '1.0.0' as const,
        start: 6,
        end: 22,
        offsetUnit: 'UNICODE_CODE_POINT' as const,
        role: 'VALUE' as const,
        location: {
          schemaVersion: '1.0.0' as const,
          kind: 'JSON_POINTER' as const,
          pointer: '/contact/email'
        }
      }]
    };
    const result = await createTextProcessingApplication(dependencies()).scan({
      session: { input: () => Promise.resolve(source) },
      requirement: { ...requirement, operation: 'SCAN' }
    }, context);

    expect(result.evidence[0]?.nativeLocations).toEqual([{
      schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '/contact/email'
    }]);
    expect(result.resolution.spans[0]?.nativeLocations).toEqual([{
      schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '/contact/email'
    }]);
  });

  it('fails safely when a detection crosses structured canonical regions', async () => {
    const sourceText = 'Email ada@example.test';
    const source = {
      ...artifact('structured://input', sourceText),
      regions: [{
        schemaVersion: '1.0.0' as const,
        start: 0,
        end: 10,
        offsetUnit: 'UNICODE_CODE_POINT' as const,
        role: 'VALUE' as const,
        location: { schemaVersion: '1.0.0' as const, kind: 'CSV_CELL' as const, row: 1, column: 1 }
      }]
    };
    await expect(createTextProcessingApplication(dependencies()).scan({
      session: { input: () => Promise.resolve(source) },
      requirement: { ...requirement, operation: 'SCAN' }
    }, context)).rejects.toMatchObject({
      code: 'SOURCE_MAP_INVALID',
      message: 'The structured source map is invalid.',
      correlationId: context.correlationId
    });
  });

  it('fails before detection when a structured policy has no adapter-owned regions', async () => {
    let detectorCalls = 0;
    const app = createTextProcessingApplication(dependencies({
      detector: {
        detectorBundleVersion: 'test-detector',
        detect: () => { detectorCalls += 1; return Promise.resolve([]); },
        detectStructured: () => { detectorCalls += 1; return Promise.resolve([]); }
      }
    }));
    await expect(app.scan({
      session: { input: () => Promise.resolve(artifact('plain://input', 'not-an-address')) },
      requirement: { ...requirement, operation: 'SCAN' },
      policy: structuredPolicy
    }, context)).rejects.toMatchObject({
      code: 'POLICY_UNSATISFIABLE',
      correlationId: context.correlationId
    });
    expect(detectorCalls).toBe(0);
  });

  it('rejects CSV header selector metadata attached to a non-CSV region', async () => {
    const sourceText = 'ada@example.test';
    const source = {
      ...artifact('structured://input', sourceText),
      regions: [{
        schemaVersion: '1.0.0' as const,
        start: 0,
        end: 16,
        offsetUnit: 'UNICODE_CODE_POINT' as const,
        role: 'VALUE' as const,
        location: {
          schemaVersion: '1.0.0' as const,
          kind: 'JSON_POINTER' as const,
          pointer: '/email'
        },
        selector: { csvHeader: 'email' }
      }]
    };
    await expect(createTextProcessingApplication(dependencies()).scan({
      session: { input: () => Promise.resolve(source) },
      requirement: { ...requirement, operation: 'SCAN' }
    }, context)).rejects.toMatchObject({
      code: 'SOURCE_MAP_INVALID',
      correlationId: context.correlationId
    });
  });

  it.each(['ephemeral', 'durable'] as const)('runs the same redact sequence for a %s session', async (kind) => {
    const session = new FakeSession(kind);
    const result = await createTextProcessingApplication(dependencies()).redact({ session, requirement, policy }, context);
    expect(result.published.reference).toBe('published://stage://pending');
    expect(result.plan.actions).toHaveLength(1);
    expect(result.policy).toMatchObject({ id: 'development-labels', digest: policy.digest });
    expect(result.plan.policy.digest).toBe(policy.digest);
    expect(result.plan.inputDigest).toBe(result.input.digest);
    expect(result.plan.resolutionDigest).toBe(result.resolution.digest);
    expect(result.plan.capabilityDigest).toBe(
      digestCapabilityManifest(manifest(), 'cor_core_capability_digest')
    );
    expect(result.plan.writer).toEqual({ id: session.writer.id, version: session.writer.version });
    expect(result.plan.expectedActionCount).toBe(result.plan.actions.length);
    expect(result.plan.actions[0]).toMatchObject({
      sourceSpanId: 'rsp_11111111111141118111111111111111',
      evidenceIds: ['11111111-1111-4111-8111-111111111111']
    });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'publish']);
  });

  it('binds a saved rejection into the plan and keeps the reviewed span', async () => {
    const sourceText = 'Email ada@example.test';
    const session = new FakeSession('ephemeral', sourceText);
    const result = await createTextProcessingApplication(dependencies()).redact({
      session,
      requirement,
      policy,
      review: {
        binding: {
          extractionRevision: revision(sourceText),
          revision: 1,
          decisionCount: 1,
          digest: digest('review-reject')
        },
        decisions: [{
          sourceSpanId: 'rsp_11111111111141118111111111111111',
          action: 'REJECT'
        }]
      }
    }, context);

    expect(result.plan.schemaVersion).toBe('2.0.0');
    if (result.plan.schemaVersion !== '2.0.0') throw new Error('Expected a reviewed plan.');
    expect(result.plan.actions).toEqual([]);
    expect(result.plan.review.decisions).toEqual([{
      sourceSpanId: 'rsp_11111111111141118111111111111111',
      action: 'REJECT',
      entityType: 'EMAIL',
      start: 6,
      end: 22
    }]);
    expect(result.policyDecisions).toContainEqual(expect.objectContaining({
      action: 'KEEP', reviewAction: 'REJECT', explanationCode: 'REVIEW_REJECTED'
    }));
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'publish']);
  });

  it('lets an explicit saved review accept or retype a below-threshold span', async () => {
    const sourceText = 'Email ada@example.test';
    const reviewedDependencies = dependencies({
      detector: {
        detectorBundleVersion: 'test-detector',
        detect: (text, extractionRevision) => Promise.resolve(emailEvidence(text, extractionRevision).map((item) => ({
          ...item,
          confidence: 0.2
        })))
      }
    });
    for (const decision of [
      { action: 'ACCEPT' as const, expectedType: 'EMAIL' as const },
      { action: 'RETYPE' as const, entityType: 'PHONE' as const, expectedType: 'PHONE' as const }
    ]) {
      const session = new FakeSession('ephemeral', sourceText);
      const result = await createTextProcessingApplication(reviewedDependencies).redact({
        session,
        requirement,
        policy,
        review: {
          binding: {
            extractionRevision: revision(sourceText),
            revision: 1,
            decisionCount: 1,
            digest: digest(`review-${decision.action}`)
          },
          decisions: [{
            sourceSpanId: 'rsp_11111111111141118111111111111111',
            ...(decision.action === 'RETYPE'
              ? { action: decision.action, entityType: decision.entityType }
              : { action: decision.action })
          }]
        }
      }, context);
      expect(result.plan.actions[0]?.entityType).toBe(decision.expectedType);
      expect(result.policyDecisions[0]).toMatchObject({
        action: 'TYPED_LABEL', reviewAction: decision.action
      });
    }
  });

  it('blocks unresolved conflicts before staging', async () => {
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      detector: { detectorBundleVersion: 'test-detector', detect: (_text, extractionRevision) => Promise.resolve([
        ...emailEvidence('Email ada@example.test', extractionRevision),
        { id: parseDetectionId('22222222-2222-4222-8222-222222222222'), entityType: 'PHONE', span: { start: 5, end: 20, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision }, confidence: 1, source: 'REGEX', detector: { id: 'phone-pattern', version: 'test' } }
      ]) }
    }));
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    expect(session.events).toEqual(['input:false']);
  });

  it('rejects an unsatisfied high-risk policy before reading input or running detection', async () => {
    const session = new FakeSession('ephemeral');
    let detectorCalls = 0;
    const app = createTextProcessingApplication(dependencies({
      detector: {
        detectorBundleVersion: 'test-detector',
        detect: () => { detectorCalls += 1; return Promise.resolve([]); }
      }
    }));
    await expect(app.redact({
      session,
      requirement,
      policy: compilePolicy(highRiskDisclosurePolicy)
    }, context)).rejects.toMatchObject({ code: 'POLICY_UNSATISFIABLE' });
    expect(session.events).toEqual([]);
    expect(detectorCalls).toBe(0);
  });

  it('rejects a writer that differs from the preflighted adapter before reading input', async () => {
    const session = new FakeSession('ephemeral');
    Object.defineProperty(session, 'writer', {
      value: { id: 'different-adapter', version: '0.1.0' }
    });
    const app = createTextProcessingApplication(dependencies());
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({
      code: 'POLICY_UNSATISFIABLE',
      details: { reason: 'writer_capability_mismatch' }
    });
    expect(session.events).toEqual([]);
  });

  it('requires review before staging when accepted evidence is below the policy threshold', async () => {
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      detector: {
        detectorBundleVersion: 'test-detector',
        detect: (text, extractionRevision) => Promise.resolve(emailEvidence(text, extractionRevision).map((item) => ({
          ...item,
          confidence: 0.94
        })))
      }
    }));
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({
      code: 'POLICY_REVIEW_REQUIRED'
    });
    expect(session.events).toEqual(['input:false']);
  });

  it('uses the injected verifier and discards a failed stage before publishing', async () => {
    const session = new FakeSession('ephemeral');
    const verifierCalls: string[] = [];
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: (request) => {
          verifierCalls.push(request.reopenedText);
          return Promise.resolve(attestationFor(request, {
            outcome: 'FAIL',
            findings: [{
              code: 'RESIDUAL_ENTITY', severity: 'ERROR', blocking: true,
              check: 'DETERMINISTIC_RESCAN', entityType: 'EMAIL', count: 1
            }]
          }));
        }
      })
    }));
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({ code: 'VERIFICATION_RESIDUAL' });
    expect(verifierCalls).toEqual(['Email [EMAIL_1]']);
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('discards staging when the verifier does not run the policy-required profile', async () => {
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: (request) => Promise.resolve(attestationFor(request, {
          profile: { id: 'wrong-profile', version: '0.1.0', digest: digest('wrong-profile') }
        }))
      })
    }));
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({
      code: 'VERIFICATION_INCOMPLETE'
    });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('rejects a tampered verification report digest before publication', async () => {
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: (request) => Promise.resolve({
          ...attestationFor(request),
          reportDigest: parseSha256Digest(`sha256:${'0'.repeat(64)}`)
        })
      })
    }));
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({
      code: 'VERIFICATION_INCOMPLETE'
    });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('rejects a validly digested attestation bound to different output bytes', async () => {
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: (request) => Promise.resolve(attestationFor(request, {
          output: { ...request.output, digest: digest('different-output-binding') }
        }))
      })
    }));
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({
      code: 'VERIFICATION_INCOMPLETE'
    });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('rejects an incomplete-only finding mislabeled as a completed FAIL', async () => {
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: (request) => Promise.resolve(attestationFor(request, {
          outcome: 'FAIL',
          findings: [{
            code: 'VERIFIER_INCOMPLETE', severity: 'ERROR', blocking: true,
            check: 'DETERMINISTIC_RESCAN', count: 1
          }]
        }))
      })
    }));
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({
      code: 'VERIFICATION_INCOMPLETE'
    });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('rejects a mandatory failure finding mislabeled as non-blocking PASS', async () => {
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: (request) => {
          const { reportDigest: _digest, ...passing } = attestationFor(request);
          void _digest;
          const malicious = {
            ...passing,
            findings: [{
              code: 'RESIDUAL_ENTITY', severity: 'INFO', blocking: false,
              check: 'DETERMINISTIC_RESCAN', entityType: 'EMAIL', count: 1
            }]
          };
          return Promise.resolve({
            ...malicious,
            reportDigest: computeVerificationAttestationDigest(
              malicious as unknown as Omit<TextVerificationAttestation, 'reportDigest'>
            )
          } as unknown as TextVerificationAttestation);
        }
      })
    }));
    await expect(app.redact({ session, requirement, policy }, context)).rejects.toMatchObject({
      code: 'VERIFICATION_INCOMPLETE'
    });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('discards staging when a validly signed writer receipt omits a planned action', async () => {
    const session = new FakeSession('ephemeral');
    const originalStage = session.stage.bind(session);
    session.stage = async (plan, signal) => {
      const staged = await originalStage(plan, signal);
      const changed = {
        schemaVersion: staged.receipt.schemaVersion,
        planDigest: staged.receipt.planDigest,
        writer: staged.receipt.writer,
        stagedDigest: staged.receipt.stagedDigest,
        stagedByteLength: staged.receipt.stagedByteLength,
        expectedActionCount: staged.receipt.expectedActionCount,
        appliedActionCount: 0,
        appliedActionIds: []
      };
      return {
        ...staged,
        receipt: { ...changed, receiptDigest: canonicalReceiptDigest(changed) }
      };
    };

    await expect(createTextProcessingApplication(dependencies()).redact({
      session,
      requirement,
      policy
    }, context)).rejects.toMatchObject({ code: 'REDACTION_COUNT_MISMATCH' });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'discard']);
  });

  it('treats a tampered writer receipt digest as incomplete and never reopens or publishes', async () => {
    const session = new FakeSession('ephemeral');
    const originalStage = session.stage.bind(session);
    session.stage = async (plan, signal) => {
      const staged = await originalStage(plan, signal);
      return {
        ...staged,
        receipt: {
          ...staged.receipt,
          receiptDigest: parseSha256Digest(`sha256:${'0'.repeat(64)}`)
        }
      };
    };

    await expect(createTextProcessingApplication(dependencies()).redact({
      session,
      requirement,
      policy
    }, context)).rejects.toMatchObject({ code: 'VERIFICATION_INCOMPLETE' });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'discard']);
  });

  it('rejects an unexpected writer action ID even when the receipt count matches', async () => {
    const session = new FakeSession('ephemeral');
    const originalStage = session.stage.bind(session);
    session.stage = async (plan, signal) => {
      const staged = await originalStage(plan, signal);
      const changed = {
        schemaVersion: staged.receipt.schemaVersion,
        planDigest: staged.receipt.planDigest,
        writer: staged.receipt.writer,
        stagedDigest: staged.receipt.stagedDigest,
        stagedByteLength: staged.receipt.stagedByteLength,
        expectedActionCount: staged.receipt.expectedActionCount,
        appliedActionCount: staged.receipt.appliedActionCount,
        appliedActionIds: [`act_${'0'.repeat(26)}`]
      };
      return {
        ...staged,
        receipt: { ...changed, receiptDigest: canonicalReceiptDigest(changed) }
      };
    };

    await expect(createTextProcessingApplication(dependencies()).redact({
      session,
      requirement,
      policy
    }, context)).rejects.toMatchObject({ code: 'REDACTION_COUNT_MISMATCH' });
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'discard']);
  });

  it('discards an already staged artifact when publication fails without leaking dependency detail', async () => {
    const session = new FakeSession('durable');
    session.publish = () => Promise.reject(new Error('private artifact storage location'));
    const app = createTextProcessingApplication(dependencies());
    const failure = await app.redact({ session, requirement, policy }, context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SafeError);
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', correlationId: context.correlationId });
    expect((failure as Error).message).not.toContain('private artifact');
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('rejects a publication result that does not match the receipted staged bytes', async () => {
    const session = new FakeSession('ephemeral');
    const originalPublish = session.publish.bind(session);
    session.publish = async (staged, signal) => ({
      ...await originalPublish(staged, signal),
      digest: digest('different-published-bytes')
    });

    await expect(createTextProcessingApplication(dependencies()).redact({
      session,
      requirement,
      policy
    }, context)).rejects.toMatchObject({ code: 'ARTIFACT_DIGEST_MISMATCH' });
    expect(session.events.map((event) => event.split(':')[0])).toEqual([
      'input', 'stage', 'reopen', 'publish', 'discard'
    ]);
  });

  it('returns a privacy-safe deterministic error when processing and cleanup both fail', async () => {
    const session = new FakeSession('ephemeral');
    session.discard = () => Promise.reject(new Error('private staging path'));
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: (request) => Promise.resolve(attestationFor(request, {
          outcome: 'FAIL',
          findings: [{
            code: 'RESIDUAL_ENTITY', severity: 'ERROR', blocking: true,
            check: 'DETERMINISTIC_RESCAN', entityType: 'EMAIL', count: 1
          }]
        }))
      })
    }));
    const failure = await app.redact({ session, requirement, policy }, context).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      correlationId: context.correlationId,
      details: { reason: 'cleanup_failed_after_VERIFICATION_RESIDUAL' }
    });
    expect((failure as Error).message).not.toContain('private staging path');
  });

  it('preserves a post-publication cleanup status when the cleanup retry also fails', async () => {
    const session = new FakeSession('ephemeral');
    const publishedCleanupFailure = new SafeError({
      code: 'STORAGE_UNAVAILABLE',
      message: 'A verified output was published, but staged artifact cleanup could not be confirmed.',
      retryable: false,
      correlationId: context.correlationId,
      details: { reason: 'stage_cleanup_failed_after_publication' }
    });
    session.publish = () => Promise.reject(publishedCleanupFailure);
    let discardCalled = false;
    session.discard = () => {
      discardCalled = true;
      return Promise.reject(new Error('private staging path'));
    };

    const failure = await createTextProcessingApplication(dependencies()).redact({
      session,
      requirement,
      policy
    }, context).catch((error: unknown) => error);

    expect(failure).toBe(publishedCleanupFailure);
    expect(failure).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      retryable: false,
      details: { reason: 'stage_cleanup_failed_after_publication' }
    });
    expect((failure as Error).message).not.toContain('private staging path');
    expect(discardCalled).toBe(false);
  });

  it('forwards cancellation to every participating port', async () => {
    const signal = AbortSignal.abort();
    const session = new FakeSession('ephemeral');
    const seen: AbortSignal[] = [];
    const app = createTextProcessingApplication(dependencies({
      capabilityProvider: { getCapabilities: (provided) => { if (provided !== undefined) seen.push(provided); return Promise.resolve(manifest()); } },
      detector: { detectorBundleVersion: 'test', detect: (text, extractionRevision, provided) => { if (provided !== undefined) seen.push(provided); return Promise.resolve(emailEvidence(text, extractionRevision)); } },
      verifier: verifierPort({
        attest: (request, provided) => {
          if (provided !== undefined) seen.push(provided);
          return Promise.resolve(attestationFor(request));
        }
      })
    }));
    await app.redact({ session, requirement, policy, signal }, context);
    expect(seen).toEqual([signal, signal, signal]);
    expect(session.events).toEqual(['input:true', 'stage:true', 'reopen:true', 'publish:true']);
  });

  it('does not pass a cancelled signal to mandatory stage cleanup', async () => {
    const signal = AbortSignal.abort();
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: (request) => Promise.resolve(attestationFor(request, {
          outcome: 'FAIL',
          findings: [{
            code: 'RESIDUAL_ENTITY', severity: 'ERROR', blocking: true,
            check: 'DETERMINISTIC_RESCAN', entityType: 'EMAIL', count: 1
          }]
        }))
      })
    }));
    await expect(app.redact({ session, requirement, policy, signal }, context)).rejects.toMatchObject({ code: 'VERIFICATION_RESIDUAL' });
    expect(session.events).toEqual(['input:true', 'stage:true', 'reopen:true', 'discard:false']);
  });

  it('maps cooperative cancellation after staging only after signal-free cleanup', async () => {
    const controller = new AbortController();
    const session = new FakeSession('ephemeral');
    const reopen = session.reopen.bind(session);
    session.reopen = async (staged, signal) => {
      const artifact = await reopen(staged, signal);
      controller.abort();
      signal?.throwIfAborted();
      return artifact;
    };
    const app = createTextProcessingApplication(dependencies());

    await expect(app.redact({
      session,
      requirement,
      policy,
      signal: controller.signal
    }, context)).rejects.toMatchObject({
      code: 'OPERATION_CANCELLED',
      retryable: false,
      correlationId: context.correlationId
    });
    expect(session.events).toEqual(['input:false', 'stage:false', 'reopen:false', 'discard:false']);
  });

  it('preserves cooperative cancellation during attestation instead of reporting incomplete verification', async () => {
    const controller = new AbortController();
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      verifier: verifierPort({
        attest: () => {
          controller.abort();
          return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
        }
      })
    }));

    await expect(app.redact({
      session,
      requirement,
      policy,
      signal: controller.signal
    }, context)).rejects.toMatchObject({ code: 'OPERATION_CANCELLED' });
    expect(session.events).toEqual(['input:false', 'stage:false', 'reopen:false', 'discard:false']);
  });

  it('does not misclassify an unrelated AbortError when the caller signal is active', async () => {
    const app = createTextProcessingApplication(dependencies({
      detector: {
        detectorBundleVersion: 'test-detector',
        detect: () => Promise.reject(new DOMException('provider aborted', 'AbortError'))
      }
    }));

    await expect(app.scan({
      session: new FakeSession('ephemeral'),
      requirement,
      signal: new AbortController().signal
    }, context)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
});
