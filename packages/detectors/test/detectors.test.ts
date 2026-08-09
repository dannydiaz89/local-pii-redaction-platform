import { describe, expect, it } from 'vitest';

import {
  parseDetectionId,
  parseSha256Digest,
  sliceByCodePoint,
  type DetectionEvidence,
  type EntityType,
  type SafeError,
  type Sha256Digest
} from '@local-pii/domain';

import {
  createCompositeTextDetector,
  defaultDetectorLimits,
  detectDeterministic,
  type ContextualTextDetectionProvider
} from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'a'.repeat(64)}`);

function modelEvidence(
  extractionRevision: Sha256Digest,
  start: number,
  end: number,
  entityType: EntityType = 'DATE_OF_BIRTH',
  id = 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa'
): DetectionEvidence {
  return {
    id: parseDetectionId(id),
    entityType,
    span: { start, end, offsetUnit: 'UNICODE_CODE_POINT', extractionRevision },
    confidence: 0.91,
    source: 'MODEL',
    detector: { id: 'contextual-test-model', version: '1.0.0' }
  };
}

describe('deterministic detectors', () => {
  it('finds the approved initial entity set with Unicode code-point offsets', () => {
    const text = [
      '😀 Email alpha@example.test',
      'Phone +1 (202) 555-0147',
      'SSN 123-45-6789',
      'Card 4242 4242 4242 4242',
      'IPv4 192.0.2.10',
      'IPv6 2001:db8::1',
      'api_key=synthetic_value_12345'
    ].join('\n');
    const evidence = detectDeterministic(text, revision);
    const values = evidence.map((item) => ({ type: item.entityType, value: sliceByCodePoint(text, item.span) }));

    expect(values).toContainEqual({ type: 'EMAIL', value: 'alpha@example.test' });
    expect(values).toContainEqual({ type: 'PHONE', value: '+1 (202) 555-0147' });
    expect(values).toContainEqual({ type: 'SSN', value: '123-45-6789' });
    expect(values).toContainEqual({ type: 'CREDIT_CARD', value: '4242 4242 4242 4242' });
    expect(values).toContainEqual({ type: 'IP_ADDRESS', value: '192.0.2.10' });
    expect(values).toContainEqual({ type: 'IP_ADDRESS', value: '2001:db8::1' });
    expect(values).toContainEqual({ type: 'API_KEY', value: 'synthetic_value_12345' });
    expect(evidence[0]?.span.start).toBe(8);
  });

  it('rejects structurally impossible SSNs and invalid Luhn candidates', () => {
    const text = 'SSN 000-12-3456 and card 4242 4242 4242 4241';
    const evidence = detectDeterministic(text, revision);
    expect(evidence.some((item) => item.entityType === 'SSN')).toBe(false);
    expect(evidence.some((item) => item.entityType === 'CREDIT_CARD')).toBe(false);
  });

  it('produces stable value-free evidence identifiers', () => {
    const text = 'alpha@example.test';
    expect(detectDeterministic(text, revision)).toEqual(detectDeterministic(text, revision));
    expect(JSON.stringify(detectDeterministic(text, revision))).not.toContain(text);
  });
});

describe('composite text detector', () => {
  it('keeps deterministic and model evidence for the same span so provenance remains available', async () => {
    const text = 'Contact alpha@example.test.';
    const start = text.indexOf('alpha@example.test');
    const contextual: ContextualTextDetectionProvider = {
      detectorBundleVersion: '1.0.0',
      detect(_text, extractionRevision) {
        return Promise.resolve([modelEvidence(extractionRevision, start, start + 'alpha@example.test'.length, 'EMAIL', 'bbbbbbbb-bbbb-5bbb-8bbb-bbbbbbbbbbbb')]);
      }
    };

    const result = await createCompositeTextDetector({ contextual }).detectWithResult(text, revision);
    const sameSpan = result.evidence.filter((item) => item.entityType === 'EMAIL' && item.span.start === start);

    expect(sameSpan).toHaveLength(2);
    expect(sameSpan.map((item) => item.source).sort()).toEqual(['MODEL', 'REGEX']);
    expect(new Set(sameSpan.map((item) => item.id)).size).toBe(2);
    expect(result.contextual).toEqual({ state: 'COMPLETED', detectorBundleVersion: '1.0.0', evidenceCount: 1 });
  });

  it('retains a model-only date of birth', async () => {
    const text = 'Patient date of birth: 1990-01-15';
    const start = text.indexOf('1990-01-15');
    const detector = createCompositeTextDetector({
      contextual: {
        detectorBundleVersion: '1.0.0',
        detect(_text, extractionRevision) {
          return Promise.resolve([modelEvidence(extractionRevision, start, start + '1990-01-15'.length)]);
        }
      }
    });

    const evidence = await detector.detect(text, revision);
    expect(evidence.filter((item) => item.entityType === 'DATE_OF_BIRTH')).toEqual([
      expect.objectContaining({ entityType: 'DATE_OF_BIRTH', source: 'MODEL' })
    ]);
  });

  it('orders combined evidence deterministically despite contextual completion timing and source ordering', async () => {
    const text = 'DOB 1990-01-15; email alpha@example.test';
    let invocation = 0;
    const detector = createCompositeTextDetector({
      contextual: {
        detectorBundleVersion: '1.0.0',
        async detect(_text, extractionRevision) {
          invocation += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, invocation % 2 === 0 ? 1 : 5));
          const date = modelEvidence(extractionRevision, 4, 14, 'DATE_OF_BIRTH', 'cccccccc-cccc-5ccc-8ccc-cccccccccccc');
          const person = modelEvidence(extractionRevision, 4, 14, 'PERSON', 'dddddddd-dddd-5ddd-8ddd-dddddddddddd');
          return invocation % 2 === 0 ? [date, person] : [person, date];
        }
      }
    });

    const first = await detector.detect(text, revision);
    const second = await detector.detect(text, revision);

    expect(second).toEqual(first);
  });

  it('binds the combined version to a contextual bundle discovered during detection', async () => {
    let contextualBundleVersion = '1.0.0';
    const contextual: ContextualTextDetectionProvider = {
      get detectorBundleVersion() { return contextualBundleVersion; },
      detect() {
        contextualBundleVersion = '1.0.0+sha.abcdef';
        return Promise.resolve([]);
      }
    };
    const detector = createCompositeTextDetector({ contextual });
    const before = detector.detectorBundleVersion;

    const result = await detector.detectWithResult('plain text', revision);

    expect(result.detectorBundleVersion).not.toBe(before);
    expect(result.detectorBundleVersion).toBe(detector.detectorBundleVersion);
    expect(result.contextual).toEqual({ state: 'COMPLETED', detectorBundleVersion: '1.0.0+sha.abcdef', evidenceCount: 0 });
  });

  it('propagates contextual provider failures and caller cancellation without fallback', async () => {
    const providerFailure = new Error('provider offline');
    const failing = createCompositeTextDetector({
      contextual: {
        detectorBundleVersion: '1.0.0',
        detect() {
          return Promise.reject(providerFailure);
        }
      }
    });
    await expect(failing.detect('plain text', revision)).rejects.toBe(providerFailure);

    let signalSeen: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const cancellable = createCompositeTextDetector({
      contextual: {
        detectorBundleVersion: '1.0.0',
        detect(_text, _revision, signal) {
          signalSeen = signal;
          markStarted();
          return new Promise<readonly DetectionEvidence[]>((_resolve, reject) => {
            if (signal !== undefined) {
              signal.addEventListener('abort', () => {
                const reason = signal.reason as unknown;
                reject(reason instanceof Error ? reason : new Error('Detection cancelled'));
              }, { once: true });
            }
          });
        }
      }
    });
    const controller = new AbortController();
    const abortFailure = new Error('cancelled by caller');
    const pending = cancellable.detect('plain text', revision, controller.signal);
    await started;
    controller.abort(abortFailure);

    await expect(pending).rejects.toBe(abortFailure);
    expect(signalSeen).toBe(controller.signal);

    const abortAfterProviderReturn = new AbortController();
    const abortAfterReturn = createCompositeTextDetector({
      contextual: {
        detectorBundleVersion: '1.0.0',
        detect() {
          abortAfterProviderReturn.abort(abortFailure);
          return Promise.resolve([]);
        }
      }
    });
    await expect(abortAfterReturn.detect('plain text', revision, abortAfterProviderReturn.signal)).rejects.toBe(abortFailure);
  });

  it('rejects contextual evidence with an invalid revision, span, or configured limit', async () => {
    const otherRevision = parseSha256Digest(`sha256:${'b'.repeat(64)}`);
    const badRevision = createCompositeTextDetector({
      contextual: {
        detectorBundleVersion: '1.0.0',
        detect() { return Promise.resolve([modelEvidence(otherRevision, 0, 4)]); }
      }
    });
    await expect(badRevision.detect('1990', revision)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' } satisfies Partial<SafeError>);

    const badSpan = createCompositeTextDetector({
      contextual: {
        detectorBundleVersion: '1.0.0',
        detect(_text, extractionRevision) { return Promise.resolve([modelEvidence(extractionRevision, 0, 99)]); }
      }
    });
    await expect(badSpan.detect('1990', revision)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' } satisfies Partial<SafeError>);

    const overLimit = createCompositeTextDetector({
      limits: { ...defaultDetectorLimits, maximumCandidateLength: 3 },
      contextual: {
        detectorBundleVersion: '1.0.0',
        detect(_text, extractionRevision) { return Promise.resolve([modelEvidence(extractionRevision, 0, 4)]); }
      }
    });
    await expect(overLimit.detect('1990', revision)).rejects.toMatchObject({ code: 'DETECTION_LIMIT_EXCEEDED' } satisfies Partial<SafeError>);
  });

  it('rejects malformed provider structure, provenance, versions, and duplicate contextual evidence', async () => {
    const valid = modelEvidence(revision, 0, 4);
    const variants: readonly unknown[] = [
      { ...valid, source: 'REGEX' },
      { ...valid, detector: { ...valid.detector, version: 'model-v1' } },
      { ...valid, unexpected: 'smuggled' },
      { ...valid, span: { ...valid.span, unexpected: 'smuggled' } },
      { ...valid, detector: { ...valid.detector, unexpected: 'smuggled' } },
      [valid, { ...valid, confidence: 0.92 }],
      [valid, { ...valid, id: parseDetectionId('eeeeeeee-eeee-5eee-8eee-eeeeeeeeeeee') }]
    ];

    for (const malformed of variants) {
      const detector = createCompositeTextDetector({
        contextual: {
          detectorBundleVersion: '1.0.0',
          detect() {
            return Promise.resolve((Array.isArray(malformed) ? malformed : [malformed]) as readonly DetectionEvidence[]);
          }
        }
      });
      await expect(detector.detect('1990', revision)).rejects.toMatchObject({ code: 'MODEL_OUTPUT_INVALID' } satisfies Partial<SafeError>);
    }
  });

  it('distinguishes no configured contextual provider from a completed zero-finding provider', async () => {
    const unavailable = await createCompositeTextDetector().detectWithResult('plain text', revision);
    const empty = await createCompositeTextDetector({
      contextual: { detectorBundleVersion: '1.0.0', detect() { return Promise.resolve([]); } }
    }).detectWithResult('plain text', revision);

    expect(unavailable.contextual).toEqual({ state: 'NOT_CONFIGURED' });
    expect(empty.contextual).toEqual({ state: 'COMPLETED', detectorBundleVersion: '1.0.0', evidenceCount: 0 });
    expect(unavailable.evidence).toEqual([]);
    expect(empty.evidence).toEqual([]);
    expect(unavailable.detectorBundleVersion).not.toBe(empty.detectorBundleVersion);
  });
});
