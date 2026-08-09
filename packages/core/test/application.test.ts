import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  SafeError,
  parseDetectionId,
  parseSha256Digest,
  type DetectionEvidence,
  type Sha256Digest
} from '@local-pii/domain';

import {
  createTextProcessingApplication,
  type CapabilityManifest,
  type CapabilityRequirement,
  type StagedTextArtifact,
  type TextArtifact,
  type TextProcessingApplicationDependencies,
  type TextProcessingSession,
  type TextVerificationReport
} from '../src/index.js';

const context = { correlationId: 'cor_core_application_001' };
const digest = (value: string): Sha256Digest => parseSha256Digest(`sha256:${createHash('sha256').update(value).digest('hex')}`);
const revision = (value: string): Sha256Digest => digest(`canonical:${value}`);

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
  schemaVersion: '1.0.0', profile: 'fake-rescan', outcome: 'PASS',
  detectorBundleVersion: 'test-verifier', checks: ['TEST'], findings: []
};

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
  stage(text: string, signal?: AbortSignal): Promise<StagedTextArtifact> {
    this.events.push(`stage:${String(signal?.aborted ?? false)}`);
    this.stagedText = text;
    return Promise.resolve({ reference: 'stage://pending', byteLength: Buffer.byteLength(text), digest: digest(text) });
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
    verifier: { verify: () => Promise.resolve(passingVerification) },
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

  it.each(['ephemeral', 'durable'] as const)('runs the same redact sequence for a %s session', async (kind) => {
    const session = new FakeSession(kind);
    const result = await createTextProcessingApplication(dependencies()).redact({ session, requirement }, context);
    expect(result.published.reference).toBe('published://stage://pending');
    expect(result.plan.actions).toHaveLength(1);
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'publish']);
  });

  it('blocks unresolved conflicts before staging', async () => {
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      detector: { detectorBundleVersion: 'test-detector', detect: (_text, extractionRevision) => Promise.resolve([
        ...emailEvidence('Email ada@example.test', extractionRevision),
        { id: parseDetectionId('22222222-2222-4222-8222-222222222222'), entityType: 'PHONE', span: { start: 5, end: 20, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision }, confidence: 1, source: 'REGEX', detector: { id: 'phone-pattern', version: 'test' } }
      ]) }
    }));
    await expect(app.redact({ session, requirement }, context)).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    expect(session.events).toEqual(['input:false']);
  });

  it('uses the injected verifier and discards a failed stage before publishing', async () => {
    const session = new FakeSession('ephemeral');
    const verifierCalls: string[] = [];
    const app = createTextProcessingApplication(dependencies({
      verifier: { verify: (text) => { verifierCalls.push(text); return Promise.resolve({ schemaVersion: '1.0.0', profile: 'injected', outcome: 'FAIL', detectorBundleVersion: 'test', checks: ['TEST'], findings: [{ code: 'TEST', severity: 'ERROR', blocking: true }] }); } }
    }));
    await expect(app.redact({ session, requirement }, context)).rejects.toMatchObject({ code: 'VERIFICATION_RESIDUAL' });
    expect(verifierCalls).toEqual(['Email [EMAIL_1]']);
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('discards an already staged artifact when publication fails without leaking dependency detail', async () => {
    const session = new FakeSession('durable');
    session.publish = () => Promise.reject(new Error('private artifact storage location'));
    const app = createTextProcessingApplication(dependencies());
    const failure = await app.redact({ session, requirement }, context).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SafeError);
    expect(failure).toMatchObject({ code: 'INTERNAL_ERROR', correlationId: context.correlationId });
    expect((failure as Error).message).not.toContain('private artifact');
    expect(session.events.map((event) => event.split(':')[0])).toEqual(['input', 'stage', 'reopen', 'discard']);
  });

  it('returns a privacy-safe deterministic error when processing and cleanup both fail', async () => {
    const session = new FakeSession('ephemeral');
    session.discard = () => Promise.reject(new Error('private staging path'));
    const app = createTextProcessingApplication(dependencies({
      verifier: { verify: () => Promise.resolve({ schemaVersion: '1.0.0', profile: 'test', outcome: 'FAIL', detectorBundleVersion: 'test', checks: ['TEST'], findings: [] }) }
    }));
    const failure = await app.redact({ session, requirement }, context).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      correlationId: context.correlationId,
      details: { reason: 'cleanup_failed_after_VERIFICATION_RESIDUAL' }
    });
    expect((failure as Error).message).not.toContain('private staging path');
  });

  it('forwards cancellation to every participating port', async () => {
    const signal = AbortSignal.abort();
    const session = new FakeSession('ephemeral');
    const seen: AbortSignal[] = [];
    const app = createTextProcessingApplication(dependencies({
      capabilityProvider: { getCapabilities: (provided) => { if (provided !== undefined) seen.push(provided); return Promise.resolve(manifest()); } },
      detector: { detectorBundleVersion: 'test', detect: (text, extractionRevision, provided) => { if (provided !== undefined) seen.push(provided); return Promise.resolve(emailEvidence(text, extractionRevision)); } },
      verifier: { verify: (_text, _revision, provided) => { if (provided !== undefined) seen.push(provided); return Promise.resolve(passingVerification); } }
    }));
    await app.redact({ session, requirement, signal }, context);
    expect(seen).toEqual([signal, signal, signal]);
    expect(session.events).toEqual(['input:true', 'stage:true', 'reopen:true', 'publish:true']);
  });

  it('does not pass a cancelled signal to mandatory stage cleanup', async () => {
    const signal = AbortSignal.abort();
    const session = new FakeSession('ephemeral');
    const app = createTextProcessingApplication(dependencies({
      verifier: { verify: () => Promise.resolve({ schemaVersion: '1.0.0', profile: 'test', outcome: 'FAIL', detectorBundleVersion: 'test', checks: ['TEST'], findings: [] }) }
    }));
    await expect(app.redact({ session, requirement, signal }, context)).rejects.toMatchObject({ code: 'VERIFICATION_RESIDUAL' });
    expect(session.events).toEqual(['input:true', 'stage:true', 'reopen:true', 'discard:false']);
  });
});
