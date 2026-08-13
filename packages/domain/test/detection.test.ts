import { describe, expect, it } from 'vitest';

import { isNativeLocationV1, isNativeLocationV2, isNativeLocationV3, isNativeLocationV4, nativeLocationIdentity } from '../src/index.js';

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

  it('accepts value-free DOCX relationship and generic XML carrier locations in v2', () => {
    const relationship = {
      schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart: 'word/header1.xml',
      relationshipId: 'rId42', field: 'TARGET'
    } as const;
    const attribute = {
      schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml',
      element: 'w:setting', elementOrdinal: 2, carrier: 'ATTRIBUTE', attribute: 'w:val'
    } as const;
    const unprefixedAttribute = {
      schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'docProps/app.xml',
      element: 'Properties', elementOrdinal: 1, carrier: 'ATTRIBUTE', attribute: 'baseType'
    } as const;

    expect(isNativeLocationV2(relationship)).toBe(true);
    expect(isNativeLocationV2(attribute)).toBe(true);
    expect(isNativeLocationV2(unprefixedAttribute)).toBe(true);
    expect(isNativeLocationV2({
      ...unprefixedAttribute,
      element: `E${'a'.repeat(63)}`,
      attribute: `a${'b'.repeat(63)}`
    })).toBe(true);
    expect(isNativeLocationV1(relationship)).toBe(false);
    expect(nativeLocationIdentity(relationship)).toBe('DOCX_RELATIONSHIP\0word/header1.xml\0rId42\0TARGET');
  });

  it('accepts only closed value-free PDF text-item coordinates in v3', () => {
    const location = {
      schemaVersion: '3.0.0' as const,
      kind: 'PDF_TEXT_ITEM' as const,
      page: 1,
      pageObject: 4,
      contentObject: 5,
      fontObject: 3,
      textItem: 2,
      glyphCount: 17
    };
    expect(isNativeLocationV3(location)).toBe(true);
    expect(isNativeLocationV2(location)).toBe(false);
    expect(nativeLocationIdentity(location)).toBe('PDF_TEXT_ITEM\0' + ['1', '4', '5', '3', '2', '17'].join('\0'));
    expect(isNativeLocationV3({ ...location, value: 'forbidden' })).toBe(false);
    expect(isNativeLocationV3({ ...location, glyphCount: 0 })).toBe(false);
  });

  it('accepts only closed value-free PDF metadata coordinates in v4', () => {
    const location = {
      schemaVersion: '4.0.0' as const, kind: 'PDF_METADATA_VALUE' as const, carrier: 'XMP' as const,
      object: 7, field: 'DC_CREATOR' as const, occurrence: 1
    };
    expect(isNativeLocationV4(location)).toBe(true);
    expect(isNativeLocationV3(location)).toBe(false);
    expect(nativeLocationIdentity(location)).toBe('PDF_METADATA_VALUE\0' + ['XMP', '7', 'DC_CREATOR', '1'].join('\0'));
    expect(isNativeLocationV4({ ...location, value: 'forbidden' })).toBe(false);
    expect(isNativeLocationV4({ ...location, field: 'UNKNOWN' })).toBe(false);
  });

  it.each([
    { schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart: '../document.xml', relationshipId: 'rId1', field: 'TARGET' },
    { schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart: 'word/document.xml', relationshipId: 'rId0', field: 'TARGET' },
    { schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart: 'word/document.xml', relationshipId: 'rId1000000', field: 'TARGET' },
    { schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart: 'word/document.xml', relationshipId: 'rId1', field: 'TARGET', target: 'planted-canary' },
    { schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml', element: 'w:setting', elementOrdinal: 1, carrier: 'TEXT', attribute: 'w:val' },
    { schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml', element: 'bad/element', elementOrdinal: 1, carrier: 'TEXT' },
    { schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml', element: `E${'a'.repeat(64)}`, elementOrdinal: 1, carrier: 'TEXT' },
    { schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml', element: 'setting', elementOrdinal: 1, carrier: 'ATTRIBUTE', attribute: `a${'b'.repeat(64)}` },
    { schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml', element: 'w:setting', elementOrdinal: 0, carrier: 'ATTRIBUTE', attribute: 'w:val' }
  ])('rejects an invalid or value-bearing v2 native location', (location) => {
    expect(isNativeLocationV2(location)).toBe(false);
  });
});
