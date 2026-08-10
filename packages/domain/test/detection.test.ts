import { describe, expect, it } from 'vitest';

import { isNativeLocationV1, nativeLocationIdentity } from '../src/index.js';

describe('typed native locations', () => {
  it('accepts bounded JSON Pointer, CSV cell, and DOCX paragraph locations', () => {
    const locations = [
      { schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '' },
      { schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '/a~1b~0c' },
      { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 2, column: 3 },
      { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/header1.xml', paragraph: 4 }
    ] as const;

    expect(locations.every(isNativeLocationV1)).toBe(true);
    expect(new Set(locations.map((location) => nativeLocationIdentity(location))).size).toBe(locations.length);
  });

  it.each([
    { schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '/bad~2escape' },
    { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 0, column: 1 },
    { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 100_001, column: 1 },
    { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 1, column: 1_001 },
    { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: '../document.xml', paragraph: 1 },
    { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 0 },
    { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 1_000_001 }
  ])('rejects an invalid native location', (location) => {
    expect(isNativeLocationV1(location)).toBe(false);
  });
});
