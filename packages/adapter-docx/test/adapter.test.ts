import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSha256Digest, unicodeCodePointLength, type EntityType } from '@local-pii/domain';
import { compileTypedLabelPlan } from '@local-pii/redaction';

import {
  createLocalDocxArtifactSession,
  docxAdapterCapabilityDescriptor,
  docxWriterDescriptor,
  readDocxArtifact,
  type DocxArtifact
} from '../src/index.js';

const roots: string[] = [];
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

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

function zip(entries: readonly { readonly name: string; readonly contents: string | Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents);
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

function packageParts(documentXml: string, additions: readonly { readonly name: string; readonly contents: string | Buffer }[] = []) {
  return [
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/></Types>`
    },
    {
      name: '_rels/.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
    },
    { name: 'word/document.xml', contents: documentXml },
    ...additions
  ];
}

function documentXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}"><w:body>${body}<w:sectPr/></w:body></w:document>`;
}

async function docxFile(document: string, additions: readonly { readonly name: string; readonly contents: string | Buffer }[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-'));
  roots.push(root);
  const path = join(root, 'document.docx');
  await writeFile(path, zip(packageParts(document, additions)));
  return path;
}

function planFor(
  source: DocxArtifact,
  spans: readonly { readonly start: number; readonly end: number; readonly entityType?: EntityType }[]
) {
  return compileTypedLabelPlan({
    extractionRevision: source.extractionRevision,
    algorithmVersion: '0.2.0',
    digest: parseSha256Digest(`sha256:${'1'.repeat(64)}`),
    spans: spans.map((span, index) => ({
      id: `rsp_${String(index + 1).padStart(32, '0')}`,
      entityType: span.entityType ?? 'EMAIL',
      start: span.start,
      end: span.end,
      confidence: 1,
      evidenceIds: [`00000000-0000-5000-8000-${String(index + 1).padStart(12, '0')}`]
    })),
    conflicts: [],
    suppressedEvidenceIds: []
  }, {
    inputDigest: source.digest,
    capabilityDigest: parseSha256Digest(`sha256:${'2'.repeat(64)}`),
    detectorBundleVersion: 'synthetic-docx-test-v1',
    policy: { id: 'development-labels', version: '0.1.0', digest: parseSha256Digest(`sha256:${'3'.repeat(64)}`), riskTier: 'LOW' },
    writer: docxWriterDescriptor
  });
}

function codePointOffsetOf(text: string, value: string): number {
  const offset = text.indexOf(value);
  if (offset < 0) throw new Error('Synthetic value is absent.');
  return unicodeCodePointLength(text.slice(0, offset));
}

describe('DOCX adapter', () => {
  it('advertises extract-only scan scope with preflight assurance rather than a native redaction verifier', () => {
    expect(docxAdapterCapabilityDescriptor.operations).toEqual(['PROBE', 'INSPECT', 'EXTRACT', 'SCAN']);
    expect(docxAdapterCapabilityDescriptor.assurance).toBe('EXTRACT_ONLY');
    expect(docxAdapterCapabilityDescriptor.verificationProfiles).toEqual(['docx-extract-v1']);
  });

  it('extracts visible body and table text across fragmented runs without changing input bytes or metadata', async () => {
    const document = documentXml(
      '<w:p><w:r><w:t>😀 alpha@</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>example.test</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>555-0100</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    );
    const path = await docxFile(document);
    const beforeBytes = await readFile(path);
    const before = await stat(path, { bigint: true });

    const artifact = await readDocxArtifact(path);

    expect(artifact.text).toBe('😀 alpha@example.test\n\u0000\n555-0100');
    expect(artifact.regions.map(({ location }) => location)).toEqual([
      { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 1 },
      { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 2 }
    ]);
    expect(await readFile(path)).toEqual(beforeBytes);
    const after = await stat(path, { bigint: true });
    expect({ mode: after.mode, size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs }).toEqual({
      mode: before.mode, size: before.size, mtimeNs: before.mtimeNs, ctimeNs: before.ctimeNs
    });
  });

  it('maps one Unicode-safe action across formatting runs and reopens the private native stage', async () => {
    const input = await docxFile(documentXml('<w:p><w:r><w:t>😀 alpha@</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>example.test</w:t></w:r><w:r><w:t> safe tail</w:t></w:r></w:p>'));
    const root = roots.at(-1) ?? '';
    const output = join(root, 'document.redacted.docx');
    const session = createLocalDocxArtifactSession(input, output);
    const source = await session.input();
    const value = 'alpha@example.test';
    const start = codePointOffsetOf(source.text, value);

    const staged = await session.stage(planFor(source, [{ start, end: start + unicodeCodePointLength(value) }]));

    expect((await stat(staged.path)).mode & 0o777).toBe(0o600);
    const reopened = await session.reopen(staged);
    expect(reopened.text).toBe('😀 [EMAIL_1] safe tail');
    expect(staged.receipt.appliedActionIds).toHaveLength(1);
    expect(await readFile(input)).not.toEqual(await readFile(staged.path));
    await session.discard(staged);
    expect(await readdir(root)).toEqual(['document.docx']);
  });

  it('publishes without clobbering and leaves the immutable input intact', async () => {
    const input = await docxFile(documentXml('<w:p><w:r><w:t>alpha@example.test</w:t></w:r></w:p>'));
    const root = roots.at(-1) ?? '';
    const output = join(root, 'document.redacted.docx');
    const original = await readFile(input);
    const session = createLocalDocxArtifactSession(input, output);
    const source = await session.input();
    const staged = await session.stage(planFor(source, [{ start: 0, end: unicodeCodePointLength(source.text) }]));
    const publication = await session.publish(staged);

    expect(publication.reference).toBe(output);
    expect((await readDocxArtifact(output)).text).toBe('[EMAIL_1]');
    expect(await readFile(input)).toEqual(original);
    await expect(stat(staged.path)).rejects.toMatchObject({ code: 'ENOENT' });

    const second = createLocalDocxArtifactSession(input, output);
    const secondSource = await second.input();
    await expect(second.stage(planFor(secondSource, []))).rejects.toMatchObject({ code: 'OUTPUT_COLLISION' });
  });

  it.each([
    ['hidden text', '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>private-canary</w:t></w:r></w:p>', []],
    ['revision', '<w:p><w:ins><w:r><w:t>private-canary</w:t></w:r></w:ins></w:p>', []],
    ['field', '<w:p><w:r><w:instrText>private-canary</w:instrText></w:r></w:p>', []],
    ['drawing', '<w:p><w:r><w:drawing/></w:r></w:p>', []],
    ['unknown Word element', '<w:p><w:unknown><w:r><w:t>private-canary</w:t></w:r></w:unknown></w:p>', []],
    ['invalid known-element nesting', '<w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>private-canary</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:p>', []],
    ['XML comment', '<!-- private-canary --><w:p><w:r><w:t>safe</w:t></w:r></w:p>', []],
    ['styles part', '<w:p><w:r><w:t>safe</w:t></w:r></w:p>', [{ name: 'word/styles.xml', contents: '<w:styles xmlns:w="urn:test"><w:style><w:name w:val="private-canary"/></w:style></w:styles>' }]],
    ['header part', '<w:p><w:r><w:t>safe</w:t></w:r></w:p>', [{ name: 'word/header1.xml', contents: 'private-canary' }]]
  ])('fails closed for %s without exposing planted content', async (_name, body, additions) => {
    const path = await docxFile(documentXml(body), additions);
    try {
      await readDocxArtifact(path);
      throw new Error('Expected the synthetic DOCX to be rejected.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
      expect((error as Error).message).not.toContain('private-canary');
      expect((error as Error).message).not.toContain(path);
    }
  });

  it('rejects external relationships before returning visible text', async () => {
    const external = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="https://private-canary.invalid/document.xml" TargetMode="External"/></Relationships>`;
    const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-'));
    roots.push(root);
    const path = join(root, 'document.docx');
    const normalParts = packageParts(documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>'));
    const contentTypes = normalParts[0];
    const document = normalParts[2];
    if (contentTypes === undefined || document === undefined) throw new Error('Synthetic package parts are incomplete.');
    await writeFile(path, zip([
      contentTypes,
      { name: '_rels/.rels', contents: external },
      document
    ]));
    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
  });

  it.each([
    ['path traversal entry', [{ name: '../private-canary.xml', contents: 'x' }]],
    ['case-folded duplicate', [{ name: 'WORD/document.xml', contents: 'x' }]]
  ])('rejects unsafe archive inventory: %s', async (_name, additions) => {
    const path = await docxFile(documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>'), additions);
    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
  });

  it('detects a corrupt payload CRC with a value-free error', async () => {
    const path = await docxFile(documentXml('<w:p><w:r><w:t>private-canary</w:t></w:r></w:p>'));
    const bytes = await readFile(path);
    bytes[40] = (bytes[40] ?? 0) ^ 0xff;
    await writeFile(path, bytes);
    await expect(readDocxArtifact(path)).rejects.toMatchObject({
      code: 'FORMAT_CORRUPT',
      message: 'The DOCX input is malformed or exceeds the supported archive or document limits.'
    });
  });

  it.each([
    [
      'multiple XML roots',
      `${documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>')}<w:document xmlns:w="${wordNamespace}"/>`
    ],
    [
      'excessive XML nesting',
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}">${'<w:r>'.repeat(128)}safe${'</w:r>'.repeat(128)}</w:document>`
    ],
    [
      'excessive XML attributes',
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}"><w:body ${Array.from({ length: 17 }, (_, index) => `a${String(index)}="x"`).join(' ')}/></w:document>`
    ]
  ])('rejects %s within the bounded XML scanner', async (_name, document) => {
    const path = await docxFile(document);
    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
  });

  it.each([
    ['zero-length', [{ start: 1, end: 1 }]],
    ['reversed', [{ start: 2, end: 1 }]],
    ['cross-paragraph', [{ start: 1, end: 8 }]],
    ['overlap', [{ start: 0, end: 2 }, { start: 1, end: 3 }]]
  ])('rejects a self-consistent %s plan before creating a stage', async (_name, spans) => {
    const input = await docxFile(documentXml('<w:p><w:r><w:t>abc</w:t></w:r></w:p><w:p><w:r><w:t>def</w:t></w:r></w:p>'));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();

    await expect(session.stage(planFor(source, spans))).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    expect(await readdir(root)).toEqual(['document.docx']);
  });

  it('requires DOCX input/output extensions and a valid configured byte bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-'));
    roots.push(root);
    const wrong = join(root, 'document.txt');
    await writeFile(wrong, 'not-a-docx');
    await expect(readDocxArtifact(wrong)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
    expect(() => createLocalDocxArtifactSession(wrong, undefined, Number.POSITIVE_INFINITY)).toThrow(TypeError);

    const input = await docxFile(documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>'));
    const session = createLocalDocxArtifactSession(input, join(roots.at(-1) ?? '', 'document.txt'));
    const source = await session.input();
    await expect(session.stage(planFor(source, []))).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
  });
});
