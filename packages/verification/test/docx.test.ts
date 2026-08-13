import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { computeWriterReceiptDigest, type RedactionWriterReceiptContract } from '@local-pii/contracts';
import { parseSha256Digest, unicodeCodePointLength, type CanonicalRegion, type Sha256Digest } from '@local-pii/domain';

import {
  verifyIndependentDocxFoundation,
  type IndependentDocxPlanBinding,
  type IndependentDocxVerificationRequest
} from '../src/docx.js';

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const actionId = 'act_00000000000000000000000001';
const carrierBoundary = '\n\u0000DOCX-CARRIER\u0000\n';

interface Entry {
  readonly name: string;
  readonly contents: string;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const contents = Buffer.from(entry.contents, 'utf8');
    const compressed = deflateRawSync(contents);
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

function paragraphPackage(
  value: string,
  extraRootRelationship = '',
  extraOverride = '',
  additions: readonly Entry[] = [],
  documentNamespace = wordNamespace,
  extraDocumentNamespaces = ''
): Buffer {
  return zip([
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/>${extraOverride}</Types>`
    },
    {
      name: '_rels/.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/>${extraRootRelationship}</Relationships>`
    },
    {
      name: 'word/document.xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${documentNamespace}"${extraDocumentNamespaces}><w:body><w:p><w:r><w:t>${value}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`
    },
    ...additions
  ]);
}

function fragmentedParagraphPackage(first: string, second: string): Buffer {
  return zip([
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/></Types>`
    },
    {
      name: '_rels/.rels',
      contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
    },
    {
      name: 'word/document.xml',
      contents: `<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>${first}</w:t></w:r><w:r><w:t>${second}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`
    }
  ]);
}

function insertPreCentralGap(input: Buffer): Buffer {
  const eocd = input.length - 22;
  const centralOffset = input.readUInt32LE(eocd + 16);
  const output = Buffer.concat([input.subarray(0, centralOffset), Buffer.from([0]), input.subarray(centralOffset)]);
  output.writeUInt32LE(centralOffset + 1, output.length - 22 + 16);
  return output;
}

function sha(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

function extractionRevision(
  sourceCanonicalText: string,
  sourceRegions: readonly CanonicalRegion[],
  paragraphNodes: Readonly<Record<number, readonly string[]>> = {}
): Sha256Digest {
  const hash = createHash('sha256').update('local-pii:docx-extraction:v3\u0000', 'utf8');
  const paragraphRegions = sourceRegions.filter((region) => region.location.kind === 'DOCX_PART');
  const parts = [...new Set(paragraphRegions.map((region) => region.location.kind === 'DOCX_PART' ? region.location.part : ''))];
  for (const part of parts) {
    hash.update(`PART:${part}\u0000`, 'utf8');
    const segmentOrdinals = new Map<number, number>();
    for (const [index, region] of sourceRegions.entries()) {
      if (region.location.kind !== 'DOCX_PART' || region.location.part !== part) continue;
      const segment = (segmentOrdinals.get(region.location.paragraph) ?? 0) + 1;
      segmentOrdinals.set(region.location.paragraph, segment);
      hash.update(`S:${String(region.location.paragraph)}:${String(segment)}:`, 'utf8');
      const nodes = paragraphNodes[index] ?? [sourceCanonicalText.slice(region.start, region.end)];
      for (const node of nodes) {
        hash.update('N:', 'utf8').update(String(Buffer.byteLength(node, 'utf8')), 'utf8').update(':', 'utf8').update(node, 'utf8');
      }
    }
  }
  for (const region of sourceRegions) {
    if (region.location.kind !== 'DOCX_RELATIONSHIP' && region.location.kind !== 'DOCX_XML_VALUE') continue;
    const value = sourceCanonicalText.slice(region.start, region.end);
    hash.update('C:', 'utf8').update(region.location.kind, 'utf8').update(':', 'utf8')
      .update(String(Buffer.byteLength(value, 'utf8')), 'utf8').update(':', 'utf8').update(value, 'utf8');
  }
  return parseSha256Digest(`sha256:${hash.digest('hex')}`);
}

function requestFor(
  inputBytes: Buffer,
  outputBytes: Buffer,
  sourceCanonicalText: string,
  sourceRegions: readonly CanonicalRegion[],
  actions: IndependentDocxPlanBinding['actions'],
  paragraphNodes: Readonly<Record<number, readonly string[]>> = {}
): IndependentDocxVerificationRequest {
  const plan: IndependentDocxPlanBinding = {
    id: 'plan_00000000000000000000000001',
    digest: parseSha256Digest(`sha256:${'a'.repeat(64)}`),
    inputDigest: sha(inputBytes),
    extractionRevision: extractionRevision(sourceCanonicalText, sourceRegions, paragraphNodes),
    capabilityDigest: parseSha256Digest(`sha256:${'c'.repeat(64)}`),
    policy: {
      id: 'development-labels', version: '0.1.0',
      digest: parseSha256Digest(`sha256:${'d'.repeat(64)}`), riskTier: 'LOW'
    },
    writer: { id: 'docx-adapter', version: '0.5.0' },
    expectedActionCount: actions.length,
    actions
  };
  const unsigned: Omit<RedactionWriterReceiptContract.WriterReceipt, 'receiptDigest'> = {
    schemaVersion: '1.0.0',
    planDigest: plan.digest,
    writer: plan.writer,
    stagedDigest: sha(outputBytes),
    stagedByteLength: outputBytes.length,
    expectedActionCount: actions.length,
    appliedActionCount: actions.length,
    appliedActionIds: actions.map(({ id }) => id)
  };
  return {
    inputBytes,
    outputBytes,
    sourceCanonicalText,
    sourceRegions,
    plan,
    writerReceipt: { ...unsigned, receiptDigest: computeWriterReceiptDigest(unsigned) },
    applicationBinding: {
      capabilityDigest: plan.capabilityDigest,
      policy: plan.policy,
      writer: { ...plan.writer, digest: parseSha256Digest(`sha256:${'e'.repeat(64)}`) },
      application: { id: 'local-pii-cli', version: '0.1.0', digest: parseSha256Digest(`sha256:${'f'.repeat(64)}`) },
      outputMediaType: mediaType,
      startedAt: '2026-08-11T00:00:00Z',
      completedAt: '2026-08-11T00:00:01Z'
    }
  };
}

function paragraphRegion(value: string): CanonicalRegion {
  return {
    schemaVersion: '1.0.0',
    start: 0,
    end: unicodeCodePointLength(value),
    offsetUnit: 'UNICODE_CODE_POINT',
    role: 'VALUE',
    location: { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 1 }
  };
}

function paragraphRegionV2(value: string): Extract<CanonicalRegion, { readonly schemaVersion: '2.0.0' }> {
  return {
    schemaVersion: '2.0.0',
    start: 0,
    end: unicodeCodePointLength(value),
    offsetUnit: 'UNICODE_CODE_POINT',
    role: 'VALUE',
    location: { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 1 }
  };
}

function paragraphAndCarriersSource(
  paragraphValue: string,
  carriers: readonly {
    readonly value: string;
    readonly location:
      | Extract<CanonicalRegion['location'], { readonly kind: 'DOCX_RELATIONSHIP' }>
      | Extract<CanonicalRegion['location'], { readonly kind: 'DOCX_XML_VALUE' }>;
  }[]
): { readonly text: string; readonly regions: readonly CanonicalRegion[]; readonly carrierStarts: readonly number[] } {
  const parts = [paragraphValue];
  const regions: CanonicalRegion[] = [paragraphRegionV2(paragraphValue)];
  const carrierStarts: number[] = [];
  let cursor = unicodeCodePointLength(paragraphValue);
  for (const carrier of carriers) {
    parts.push(carrierBoundary, carrier.value);
    cursor += unicodeCodePointLength(carrierBoundary);
    carrierStarts.push(cursor);
    regions.push({
      schemaVersion: '2.0.0', start: cursor, end: cursor + unicodeCodePointLength(carrier.value),
      offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE', location: carrier.location
    });
    cursor += unicodeCodePointLength(carrier.value);
  }
  return {
    text: parts.join(''),
    regions,
    carrierStarts
  };
}

describe('independent DOCX verification foundation', () => {
  it('reconciles one exact native paragraph delta without importing the DOCX adapter', () => {
    const source = 'alpha@example.test';
    const input = paragraphPackage(source);
    const output = paragraphPackage('[EMAIL_1]');
    const request = requestFor(input, output, source, [paragraphRegion(source)], [{
      id: actionId, entityType: 'EMAIL', start: 0, end: unicodeCodePointLength(source), replacement: '[EMAIL_1]'
    }]);

    const inputSnapshot = Buffer.from(input);
    const outputSnapshot = Buffer.from(output);
    const result = verifyIndependentDocxFoundation(request);

    expect(result).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS',
      findings: [],
      inputEntryCount: 3,
      outputEntryCount: 3,
      retainedRegionCount: 1,
      expectedActionCount: 1,
      appliedActionCount: 1,
      independentParser: true,
      fidelityVerified: false,
      authorizesPublication: false,
      suppliedApplicationInputsBound: true
    });
    expect(result.suppliedApplicationBindingDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(input).toEqual(inputSnapshot);
    expect(output).toEqual(outputSnapshot);
  });

  it('reconciles exact fragmented-run deltas and rejects equivalent text redistributed across carriers', () => {
    const prefix = 'prefix ';
    const sourceValue = 'alpha@example.test';
    const suffix = ' suffix';
    const source = `${prefix}${sourceValue}${suffix}`;
    const input = fragmentedParagraphPackage(`${prefix}alpha@`, `example.test${suffix}`);
    const expectedOutput = fragmentedParagraphPackage(`${prefix}[EMAIL_1]`, suffix);
    const redistributedOutput = fragmentedParagraphPackage(prefix, `[EMAIL_1]${suffix}`);
    const start = unicodeCodePointLength(prefix);
    const actions: IndependentDocxPlanBinding['actions'] = [{
      id: actionId, entityType: 'EMAIL', start, end: start + unicodeCodePointLength(sourceValue), replacement: '[EMAIL_1]'
    }];

    const nodes = { 0: [`${prefix}alpha@`, `example.test${suffix}`] };
    expect(verifyIndependentDocxFoundation(requestFor(input, expectedOutput, source, [paragraphRegion(source)], actions, nodes))).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS', findings: []
    });
    expect(verifyIndependentDocxFoundation(requestFor(input, redistributedOutput, source, [paragraphRegion(source)], actions, nodes))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'UNPLANNED_NATIVE_DELTA', count: 1 }]
    });
  });

  it('does not misclassify a paragraph tab-stop definition as a visible segment boundary', () => {
    const source = 'leftright';
    const input = zip([
      {
        name: '[Content_Types].xml',
        contents: `<?xml version="1.0"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/></Types>`
      },
      {
        name: '_rels/.rels',
        contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
      },
      {
        name: 'word/document.xml',
        contents: `<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>left</w:t></w:r><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>right</w:t></w:r></w:p></w:body></w:document>`
      }
    ]);

    expect(verifyIndependentDocxFoundation(requestFor(
      input,
      input,
      source,
      [paragraphRegion(source)],
      [],
      { 0: ['left', 'right'] }
    ))).toMatchObject({ outcome: 'RECONCILED_SUPPLIED_REGIONS', classifiedRegionCount: 1 });
  });

  it('independently resolves and reconciles an external relationship target carrier', () => {
    const source = 'mailto:alpha@example.test';
    const outputValue = 'mailto:[EMAIL_1]';
    const packageFor = (target: string) => zip([
      {
        name: '[Content_Types].xml',
        contents: `<?xml version="1.0"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/></Types>`
      },
      {
        name: '_rels/.rels',
        contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
      },
      {
        name: 'word/document.xml',
        contents: `<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:hyperlink r:id="rId2"><w:r><w:t>safe</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`
      },
      {
        name: 'word/_rels/document.xml.rels',
        contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}hyperlink" Target="${target}" TargetMode="External"/></Relationships>`
      }
    ]);
    const input = packageFor(source);
    const output = packageFor(outputValue);
    const classified = paragraphAndCarriersSource('safe', [{
      value: source,
      location: { schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart: 'word/document.xml', relationshipId: 'rId2', field: 'TARGET' }
    }]);
    const carrierStart = classified.carrierStarts[0] ?? 0;
    const request = requestFor(input, output, classified.text, classified.regions, [{
      id: actionId, entityType: 'EMAIL', start: carrierStart + unicodeCodePointLength('mailto:'),
      end: carrierStart + unicodeCodePointLength(source), replacement: '[EMAIL_1]'
    }]);

    expect(verifyIndependentDocxFoundation(request)).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS',
      findings: [],
      retainedRegionCount: 2,
      classifiedRegionCount: 2
    });
  });

  it('independently resolves and reconciles a typed XML attribute carrier', () => {
    const source = 'alpha@example.test';
    const outputValue = '[EMAIL_1]';
    const packageFor = (value: string) => zip([
      {
        name: '[Content_Types].xml',
        contents: `<?xml version="1.0"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`
      },
      {
        name: '_rels/.rels',
        contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
      },
      { name: 'word/document.xml', contents: `<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>safe</w:t></w:r></w:p><w:sectPr/></w:body></w:document>` },
      {
        name: 'word/_rels/document.xml.rels',
        contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}settings" Target="settings.xml"/></Relationships>`
      },
      {
        name: 'word/settings.xml',
        contents: `<w:settings xmlns:w="${wordNamespace}"><w:compat><w:compatSetting w:name="${value}" w:uri="https://synthetic.invalid/settings" w:val="safe-profile"/></w:compat></w:settings>`
      }
    ]);
    const input = packageFor(source);
    const output = packageFor(outputValue);
    const classified = paragraphAndCarriersSource('safe', [
      { value: source, location: {
        schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml',
        element: 'w:compatSetting', elementOrdinal: 1, carrier: 'ATTRIBUTE', attribute: 'w:name'
      } },
      { value: 'https://synthetic.invalid/settings', location: {
        schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml',
        element: 'w:compatSetting', elementOrdinal: 1, carrier: 'ATTRIBUTE', attribute: 'w:uri'
      } },
      { value: 'safe-profile', location: {
        schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/settings.xml',
        element: 'w:compatSetting', elementOrdinal: 1, carrier: 'ATTRIBUTE', attribute: 'w:val'
      } }
    ]);
    const carrierStart = classified.carrierStarts[0] ?? 0;
    const request = requestFor(input, output, classified.text, classified.regions, [{
      id: actionId, entityType: 'EMAIL', start: carrierStart,
      end: carrierStart + unicodeCodePointLength(source), replacement: outputValue
    }]);

    expect(verifyIndependentDocxFoundation(request)).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS', findings: [], retainedRegionCount: 4, classifiedRegionCount: 4
    });
  });

  it('fails a planted source canary retained in a separately enumerated metadata carrier', () => {
    const source = 'alpha@example.test';
    const coreRelationship = '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>';
    const coreOverride = '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>';
    const core: Entry = {
      name: 'docProps/core.xml',
      contents: `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${source}</dc:creator></cp:coreProperties>`
    };
    const input = paragraphPackage(source, coreRelationship, coreOverride, [core]);
    const output = paragraphPackage('[EMAIL_1]', coreRelationship, coreOverride, [core]);
    const classified = paragraphAndCarriersSource(source, [{
      value: source,
      location: {
        schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'docProps/core.xml',
        element: 'dc:creator', elementOrdinal: 1, carrier: 'TEXT'
      }
    }]);
    const request = requestFor(input, output, classified.text, classified.regions, [{
      id: actionId, entityType: 'EMAIL', start: 0, end: unicodeCodePointLength(source), replacement: '[EMAIL_1]'
    }]);

    const result = verifyIndependentDocxFoundation(request);
    expect(result).toMatchObject({
      outcome: 'FAIL',
      authorizesPublication: false
    });
    expect(result.findings).toContainEqual({ code: 'RESIDUAL_ENTITY', count: 1, entityType: 'EMAIL' });

    const omitted = requestFor(
      input,
      input,
      source,
      [paragraphRegionV2(source)],
      []
    );
    const omittedResult = verifyIndependentDocxFoundation(omitted);
    expect(omittedResult).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'CARRIER_CLASSIFICATION_MISMATCH', count: 1 }]
    });
    expect(JSON.stringify(omittedResult)).not.toContain(source);
  });

  it('rejects a forged extraction revision after reconstructing the complete native map', () => {
    const source = 'safe';
    const input = paragraphPackage(source);
    const valid = requestFor(input, input, source, [paragraphRegion(source)], []);
    expect(verifyIndependentDocxFoundation(valid)).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS', classifiedRegionCount: 1
    });

    const forged = {
      ...valid,
      plan: { ...valid.plan, extractionRevision: parseSha256Digest(`sha256:${'f'.repeat(64)}`) }
    };
    expect(verifyIndependentDocxFoundation(forged)).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'EXTRACTION_REVISION_MISMATCH', count: 1 }]
    });

    const region = valid.sourceRegions[0];
    if (region === undefined || region.location.kind !== 'DOCX_PART') throw new Error('Synthetic paragraph region missing');
    const forgedLocation = {
      ...valid,
      sourceRegions: [{
        ...region,
        location: { ...region.location, schemaVersion: '9.9.9' }
      } as unknown as CanonicalRegion]
    };
    expect(verifyIndependentDocxFoundation(forgedLocation)).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'CARRIER_CLASSIFICATION_MISMATCH', count: 1 }]
    });
  });

  it('fails residual PII in generic XML carriers even when the supplied native region list is empty', () => {
    const source = 'alpha@example.test';
    const input = paragraphPackage(source);
    const result = verifyIndependentDocxFoundation(requestFor(input, input, '', [], []));

    expect(result.outcome).toBe('INCOMPLETE');
    expect(result.findings).toContainEqual({ code: 'CARRIER_CLASSIFICATION_MISMATCH', count: 1 });
    expect(result.authorizesPublication).toBe(false);

    const fragmented = fragmentedParagraphPackage('alpha@', 'example.test');
    const fragmentedResult = verifyIndependentDocxFoundation(requestFor(fragmented, fragmented, '', [], []));
    expect(fragmentedResult.outcome).toBe('INCOMPLETE');
    expect(fragmentedResult.findings).toContainEqual({ code: 'CARRIER_CLASSIFICATION_MISMATCH', count: 1 });
  });

  it('permits only an exact rejected reviewed residual and binds privacy-safe application inputs', () => {
    const first = 'alpha@example.test';
    const second = 'beta@example.test';
    const source = `${first} ${second}`;
    const output = `[EMAIL_1] ${second}`;
    const inputBytes = paragraphPackage(source);
    const outputBytes = paragraphPackage(output);
    const firstSpanId = `rsp_${'1'.repeat(32)}`;
    const secondSpanId = `rsp_${'2'.repeat(32)}`;
    const secondStart = unicodeCodePointLength(`${first} `);
    const base = requestFor(inputBytes, outputBytes, source, [paragraphRegion(source)], [{
      id: actionId, entityType: 'EMAIL', start: 0, end: unicodeCodePointLength(first), replacement: '[EMAIL_1]'
    }]);
    const baseAction = base.plan.actions[0];
    if (baseAction === undefined) throw new Error('Synthetic reviewed action missing');
    const reviewedPlan: IndependentDocxPlanBinding = {
      ...base.plan,
      actions: [{ ...baseAction, sourceSpanId: firstSpanId }],
      review: {
        extractionRevision: base.plan.extractionRevision,
        revision: 2,
        decisionCount: 2,
        digest: parseSha256Digest(`sha256:${'7'.repeat(64)}`),
        decisions: [
          { sourceSpanId: firstSpanId, action: 'ACCEPT', entityType: 'EMAIL', start: 0, end: unicodeCodePointLength(first) },
          { sourceSpanId: secondSpanId, action: 'REJECT', entityType: 'EMAIL', start: secondStart, end: unicodeCodePointLength(source) }
        ]
      }
    };
    const reviewed = { ...base, plan: reviewedPlan };
    const result = verifyIndependentDocxFoundation(reviewed);
    expect(result).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS', findings: [], reviewedResidualCount: 1,
      suppliedApplicationInputsBound: true, authorizesPublication: false
    });

    expect(verifyIndependentDocxFoundation(base)).toMatchObject({
      outcome: 'FAIL', findings: [{ code: 'RESIDUAL_ENTITY', count: 1, entityType: 'EMAIL' }]
    });
    const review = reviewedPlan.review;
    if (review === undefined) throw new Error('Synthetic review binding missing');
    const shiftedReview = {
      ...reviewed,
      plan: {
        ...reviewedPlan,
        review: { ...review, decisions: review.decisions.map((decision) =>
          decision.action === 'REJECT' ? { ...decision, start: decision.start - 1 } : decision) }
      }
    };
    const shiftedReviewResult = verifyIndependentDocxFoundation(shiftedReview);
    expect(shiftedReviewResult).toMatchObject({
      outcome: 'FAIL', findings: [{ code: 'RESIDUAL_ENTITY', count: 1, entityType: 'EMAIL' }],
      suppliedApplicationInputsBound: true
    });
    expect(shiftedReviewResult.suppliedApplicationBindingDigest).not.toBe(result.suppliedApplicationBindingDigest);

    const forgedAction = {
      ...reviewed,
      plan: {
        ...reviewedPlan,
        review: {
          ...review,
          decisions: review.decisions.map((decision) => decision.action === 'ACCEPT'
            ? { ...decision, action: 'ALLOW' as 'ACCEPT' }
            : decision)
        }
      }
    };
    expect(verifyIndependentDocxFoundation(forgedAction)).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'BINDING_MISMATCH', count: 1 }]
    });

    const overlappingReject = {
      ...reviewed,
      plan: {
        ...reviewedPlan,
        review: {
          ...review,
          revision: 1,
          decisionCount: 1,
          decisions: [{
            sourceSpanId: secondSpanId, action: 'REJECT' as const, entityType: 'EMAIL' as const,
            start: 0, end: unicodeCodePointLength(first)
          }]
        }
      }
    };
    expect(verifyIndependentDocxFoundation(overlappingReject)).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'BINDING_MISMATCH', count: 1 }]
    });

    const forgedApplication = {
      ...reviewed,
      applicationBinding: {
        ...reviewed.applicationBinding,
        application: { ...reviewed.applicationBinding.application, digest: 'not-a-digest' as Sha256Digest }
      }
    };
    expect(verifyIndependentDocxFoundation(forgedApplication)).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'BINDING_MISMATCH', count: 1 }], suppliedApplicationInputsBound: false
    });
  });

  it('returns privacy-safe incomplete evidence for an unplanned native delta or forged receipt', () => {
    const source = 'alpha@example.test';
    const input = paragraphPackage(source);
    const output = paragraphPackage('[EMAIL_1]', '', '', [{ name: 'word/extra.xml', contents: '<x/>' }]);
    const base = requestFor(input, output, source, [paragraphRegion(source)], [{
      id: actionId, entityType: 'EMAIL', start: 0, end: unicodeCodePointLength(source), replacement: '[EMAIL_1]'
    }]);
    const inventory = verifyIndependentDocxFoundation(base);
    expect(inventory.outcome).toBe('INCOMPLETE');
    expect(inventory.findings).toHaveLength(1);
    expect(JSON.stringify(inventory)).not.toContain(source);

    const validOutput = paragraphPackage('[EMAIL_1]');
    const valid = requestFor(input, validOutput, source, [paragraphRegion(source)], base.plan.actions);
    const forged = { ...valid, writerReceipt: { ...valid.writerReceipt, appliedActionIds: [] } };
    expect(verifyIndependentDocxFoundation(forged)).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'BINDING_MISMATCH', count: 1 }]
    });
  });

  it('rejects hidden pre-central ZIP bytes and raw less-than signs in XML attributes', () => {
    const source = 'safe';
    const valid = paragraphPackage(source);
    const gapped = insertPreCentralGap(valid);
    expect(verifyIndependentDocxFoundation(requestFor(gapped, gapped, source, [paragraphRegion(source)], []))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'PACKAGE_INVALID', count: 1 }]
    });

    const malformedAttribute = zip([
      {
        name: '[Content_Types].xml',
        contents: `<?xml version="1.0"?><Types xmlns="${contentTypesNamespace}<"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/></Types>`
      },
      {
        name: '_rels/.rels',
        contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
      },
      { name: 'word/document.xml', contents: `<w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:r><w:t>${source}</w:t></w:r></w:p></w:body></w:document>` }
    ]);
    expect(verifyIndependentDocxFoundation(requestFor(malformedAttribute, malformedAttribute, source, [paragraphRegion(source)], []))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'PACKAGE_INVALID', count: 1 }]
    });
  });

  it('rejects an unplanned namespace-binding change', () => {
    const source = 'safe';
    const input = paragraphPackage(source);
    const output = paragraphPackage(source, '', '', [], 'urn:synthetic:changed-word-namespace');

    expect(verifyIndependentDocxFoundation(requestFor(input, output, source, [paragraphRegion(source)], []))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'UNPLANNED_NATIVE_DELTA', count: 1 }]
    });

    const collisionInput = paragraphPackage(source, '', '', [], wordNamespace, ' xmlns:a="x,xmlns:b=y" xmlns:b="z"');
    const collisionOutput = paragraphPackage(source, '', '', [], wordNamespace, ' xmlns:a="x" xmlns:b="y,xmlns:b=z"');
    expect(verifyIndependentDocxFoundation(requestFor(collisionInput, collisionOutput, source, [paragraphRegion(source)], []))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'UNPLANNED_NATIVE_DELTA', count: 1 }]
    });
  });
});
