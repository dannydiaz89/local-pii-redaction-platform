import { describe, expect, it } from 'vitest';

import { detectDeterministic } from '@local-pii/detectors';
import {
  parseDetectionId,
  parseSha256Digest,
  unicodeCodePointLength,
  type DetectionEvidence
} from '@local-pii/domain';

import { resolveEvidence } from '../src/index.js';

const revision = parseSha256Digest(`sha256:${'b'.repeat(64)}`);

describe('span resolution', () => {
  it('uses declared containment precedence for parsed IPs over phone-shaped evidence', () => {
    const text = '192.0.2.10';
    const result = resolveEvidence(detectDeterministic(text, revision), revision, unicodeCodePointLength(text));
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.entityType).toBe('IP_ADDRESS');
    expect(result.conflicts).toHaveLength(0);
    expect(result.suppressedEvidenceIds).toHaveLength(1);
  });

  it('is independent of detector completion order', () => {
    const text = 'alpha@example.test and 192.0.2.10';
    const evidence = detectDeterministic(text, revision);
    const forward = resolveEvidence(evidence, revision, unicodeCodePointLength(text));
    const reverse = resolveEvidence([...evidence].reverse(), revision, unicodeCodePointLength(text));
    expect(reverse).toEqual(forward);
    expect(forward.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('binds complete evidence provenance into the resolution digest', () => {
    const text = 'alpha@example.test';
    const evidence = detectDeterministic(text, revision);
    const original = resolveEvidence(evidence, revision, unicodeCodePointLength(text));
    const changedConfidence = resolveEvidence(evidence.map((item) => ({
      ...item,
      confidence: item.confidence - 0.01
    })), revision, unicodeCodePointLength(text));
    const changedDetector = resolveEvidence(evidence.map((item) => ({
      ...item,
      detector: { ...item.detector, version: '9.9.9' }
    })), revision, unicodeCodePointLength(text));

    expect(changedConfidence.digest).not.toBe(original.digest);
    expect(changedDetector.digest).not.toBe(original.digest);
    expect(Object.isFrozen(original)).toBe(true);
    expect(Object.isFrozen(original.spans)).toBe(true);
  });

  it('carries typed native locations and binds them into the resolution digest', () => {
    const text = 'alpha@example.test';
    const evidence = detectDeterministic(text, revision).map((item) => ({
      ...item,
      nativeLocations: [{
        schemaVersion: '1.0.0' as const,
        kind: 'CSV_CELL' as const,
        row: 2,
        column: 3
      }]
    }));
    const original = resolveEvidence(evidence, revision, unicodeCodePointLength(text));
    const moved = resolveEvidence(evidence.map((item) => ({
      ...item,
      nativeLocations: item.nativeLocations[0] === undefined
        ? []
        : [{ ...item.nativeLocations[0], row: 3 }]
    })), revision, unicodeCodePointLength(text));

    expect(original.algorithmVersion).toBe('0.3.0');
    expect(original.spans[0]?.nativeLocations).toEqual([{
      schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 2, column: 3
    }]);
    expect(moved.digest).not.toBe(original.digest);
  });

  it('normalizes DOCX relationship locations and binds their safe identity into the v3 digest', () => {
    const text = 'alpha@example.test';
    const first = detectDeterministic(text, revision)[0];
    if (first === undefined) throw new Error('Synthetic detector fixture produced no evidence');
    const location = {
      schemaVersion: '2.0.0' as const,
      kind: 'DOCX_RELATIONSHIP' as const,
      sourcePart: 'word/document.xml',
      relationshipId: 'rId1',
      field: 'TARGET' as const
    };
    const original = resolveEvidence([{ ...first, nativeLocations: [location] }], revision, unicodeCodePointLength(text));
    const moved = resolveEvidence([{ ...first, nativeLocations: [{ ...location, relationshipId: 'rId2' }] }], revision, unicodeCodePointLength(text));

    expect(original.algorithmVersion).toBe('0.3.0');
    expect(original.spans[0]?.nativeLocations).toEqual([location]);
    expect(moved.digest).not.toBe(original.digest);
  });

  it('normalizes value-free PDF text-item locations into resolved evidence', () => {
    const text = 'alpha@example.test';
    const first = detectDeterministic(text, revision)[0];
    if (first === undefined) throw new Error('Synthetic detector fixture produced no evidence');
    const location = {
      schemaVersion: '3.0.0' as const,
      kind: 'PDF_TEXT_ITEM' as const,
      page: 1,
      pageObject: 4,
      contentObject: 5,
      fontObject: 3,
      textItem: 1,
      glyphCount: text.length
    };
    const result = resolveEvidence([{ ...first, nativeLocations: [location] }], revision, unicodeCodePointLength(text));
    expect(result.spans[0]?.nativeLocations).toEqual([location]);
  });

  it('rejects same-span supporting evidence with inconsistent native locations', () => {
    const text = 'alpha@example.test';
    const first = detectDeterministic(text, revision)[0];
    if (first === undefined) throw new Error('Synthetic detector fixture produced no evidence');
    const locations = [
      { schemaVersion: '1.0.0' as const, kind: 'JSON_POINTER' as const, pointer: '/first' },
      { schemaVersion: '1.0.0' as const, kind: 'JSON_POINTER' as const, pointer: '/second' }
    ];
    const firstLocation = locations[0];
    const secondLocation = locations[1];
    if (firstLocation === undefined || secondLocation === undefined) throw new Error('Synthetic locations are absent');
    const second: DetectionEvidence = {
      ...first,
      id: parseDetectionId('33333333-3333-4333-8333-333333333333'),
      nativeLocations: [secondLocation]
    };
    expect(() => resolveEvidence([
      { ...first, nativeLocations: [firstLocation] }, second
    ], revision, unicodeCodePointLength(text))).toThrow('Supporting evidence native locations do not match');
  });

  it('normalizes multiple native locations with locale-independent lexical ordering', () => {
    const text = 'alpha@example.test';
    const first = detectDeterministic(text, revision)[0];
    if (first === undefined) throw new Error('Synthetic detector fixture produced no evidence');
    const locations = [
      { schemaVersion: '1.0.0' as const, kind: 'JSON_POINTER' as const, pointer: '/é' },
      { schemaVersion: '1.0.0' as const, kind: 'JSON_POINTER' as const, pointer: '/z' }
    ];
    const forward = resolveEvidence([{ ...first, nativeLocations: locations }], revision, unicodeCodePointLength(text));
    const reverse = resolveEvidence([{ ...first, nativeLocations: [...locations].reverse() }], revision, unicodeCodePointLength(text));

    expect(forward.digest).toBe(reverse.digest);
    expect(forward.spans[0]?.nativeLocations).toEqual(reverse.spans[0]?.nativeLocations);
  });

  it('retains every supporting evidence identifier for the same resolved span', () => {
    const text = 'alpha@example.test';
    const first = detectDeterministic(text, revision)[0];
    if (first === undefined) throw new Error('Synthetic detector fixture produced no evidence');
    const second: DetectionEvidence = {
      ...first,
      id: parseDetectionId('33333333-3333-4333-8333-333333333333'),
      source: 'DICTIONARY',
      detector: { id: 'synthetic-dictionary', version: '0.1.0' }
    };
    const result = resolveEvidence([first, second], revision, unicodeCodePointLength(text));
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]?.evidenceIds).toEqual([first.id, second.id].sort());
  });

  it('rejects evidence bound to a different extraction revision', () => {
    const text = 'alpha@example.test';
    const evidence = detectDeterministic(text, revision);
    const otherRevision = parseSha256Digest(`sha256:${'c'.repeat(64)}`);
    expect(() => resolveEvidence(evidence, otherRevision, unicodeCodePointLength(text))).toThrow(
      'Evidence extraction revision mismatch'
    );
  });

  it('surfaces incompatible partial overlaps', () => {
    const base = {
      span: { offsetUnit: 'UNICODE_CODE_POINT' as const, extractionRevision: revision },
      confidence: 0.9,
      source: 'REGEX' as const,
      detector: { id: 'synthetic', version: '0.1.0' }
    };
    const evidence: DetectionEvidence[] = [
      {
        ...base,
        id: parseDetectionId('11111111-1111-4111-8111-111111111111'),
        entityType: 'EMAIL',
        span: { ...base.span, start: 0, end: 8 }
      },
      {
        ...base,
        id: parseDetectionId('22222222-2222-4222-8222-222222222222'),
        entityType: 'PHONE',
        span: { ...base.span, start: 5, end: 12 }
      }
    ];
    const result = resolveEvidence(evidence, revision, 20);
    expect(result.conflicts).toHaveLength(1);
  });
});
