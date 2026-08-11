import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSha256Digest, unicodeCodePointLength, type EntityType } from '@local-pii/domain';
import { assertTypedLabelPlanIntegrity, compileTypedLabelPlan, type TypedLabelPlan } from '@local-pii/redaction';

import {
  createLocalDocxArtifactSession,
  docxAdapterCapabilityDescriptor,
  docxWriterDescriptor,
  readDocxArtifact,
  reconcileDocxStageFoundation,
  type DocxArtifact
} from '../src/index.js';

const roots: string[] = [];
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const mediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const officeRelationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const supportedPartContentTypes = {
  header: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
  footer: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
  footnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
  endnotes: 'application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml'
} as const;

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

interface SyntheticZipEntry {
  readonly name: string;
  readonly contents: string | Buffer;
  readonly flags?: number;
  readonly localExtra?: Buffer;
}

function zip(entries: readonly SyntheticZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.isBuffer(entry.contents) ? entry.contents : Buffer.from(entry.contents);
    const compressed = deflateRawSync(contents);
    const flags = entry.flags ?? 0x0800;
    const localExtra = entry.localExtra ?? Buffer.alloc(0);
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, localExtra, compressed);
    centrals.push(central, name);
    offset += local.length + name.length + localExtra.length + compressed.length;
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

function growthHint(paddingBytes: number): Buffer {
  const extra = Buffer.alloc(8 + paddingBytes);
  extra.writeUInt16LE(0xa220, 0);
  extra.writeUInt16LE(4 + paddingBytes, 2);
  extra.writeUInt16LE(0xa028, 4);
  extra.writeUInt16LE(paddingBytes, 6);
  return extra;
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

interface SupportedTextPart {
  readonly id: string;
  readonly kind: keyof typeof supportedPartContentTypes;
  readonly name: string;
  readonly contents: string;
}

function supportedPackageParts(document: string, parts: readonly SupportedTextPart[]): SyntheticZipEntry[] {
  const overrides = parts.map((part) => `<Override PartName="/word/${part.name}" ContentType="${supportedPartContentTypes[part.kind]}"/>`).join('');
  const relationships = parts.map((part) => `<Relationship Id="${part.id}" Type="${officeRelationshipPrefix}${part.kind}" Target="${part.name}"/>`).join('');
  return [
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/>${overrides}</Types>`
    },
    {
      name: '_rels/.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
    },
    { name: 'word/document.xml', contents: document },
    {
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}">${relationships}</Relationships>`
    },
    ...[...parts].reverse().map((part) => ({ name: `word/${part.name}`, contents: part.contents }))
  ];
}

const compatibilityNamespaces = {
  mc: markupCompatibilityNamespace,
  r: officeRelationshipNamespace,
  w: wordNamespace,
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
  w15: 'http://schemas.microsoft.com/office/word/2012/wordml',
  w16cex: 'http://schemas.microsoft.com/office/word/2018/wordml/cex',
  w16cid: 'http://schemas.microsoft.com/office/word/2016/wordml/cid',
  w16: 'http://schemas.microsoft.com/office/word/2018/wordml',
  w16sdtdh: 'http://schemas.microsoft.com/office/word/2020/wordml/sdtdatahash',
  w16sdtfl: 'http://schemas.microsoft.com/office/word/2024/wordml/sdtformatlock',
  w16se: 'http://schemas.microsoft.com/office/word/2015/wordml/symex',
  w16du: 'http://schemas.microsoft.com/office/word/2023/wordml/word16du'
} as const;

function passivePackageParts(document: string, theme: string, webSettings: string): SyntheticZipEntry[] {
  const namespaceAttributes = Object.entries(compatibilityNamespaces).map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`).join(' ');
  if (!webSettings.includes(namespaceAttributes)) throw new Error('Synthetic web settings namespace inventory is incomplete.');
  return [
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/word/webSettings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.webSettings+xml"/></Types>`
    },
    {
      name: '_rels/.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
    },
    { name: 'word/document.xml', contents: document },
    {
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}theme" Target="theme/theme1.xml"/><Relationship Id="rId3" Type="${officeRelationshipPrefix}webSettings" Target="webSettings.xml"/></Relationships>`
    },
    { name: 'word/theme/theme1.xml', contents: theme },
    { name: 'word/webSettings.xml', contents: webSettings }
  ];
}

function passiveWebSettings(): string {
  const namespaces = Object.entries(compatibilityNamespaces).map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`).join(' ');
  const ignorable = Object.keys(compatibilityNamespaces).filter((prefix) => !['mc', 'r', 'w'].includes(prefix)).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?><w:webSettings ${namespaces} mc:Ignorable="${ignorable}"/>`;
}

function passiveTheme(): string {
  const colors = ['000000', 'FFFFFF', '1F497D', 'EEECE1', '4F81BD', 'C0504D', '9BBB59', '8064A2', '4BACC6', 'F79646', '0000FF', '800080'];
  const colorNames = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  const colorScheme = colorNames.map((name, index) => `<a:${name}><a:srgbClr val="${colors[index] ?? '000000'}"/></a:${name}>`).join('');
  const scheme = (index: number) => `<a:schemeClr val="accent${String((index % 6) + 1)}">${index < 7 ? '<a:tint val="50000"/>' : ''}${index < 5 ? '<a:shade val="50000"/>' : ''}${index < 8 ? '<a:lumMod val="75000"/>' : ''}</a:schemeClr>`;
  const gradients = Array.from({ length: 3 }, (_, gradient) => `<a:gradFill><a:gsLst>${Array.from({ length: 3 }, (_unused, stop) => `<a:gs pos="${String(stop * 50_000)}">${scheme(gradient * 3 + stop)}</a:gs>`).join('')}</a:gsLst><a:lin ang="5400000" scaled="1"/><a:tileRect/></a:gradFill>`);
  const fillStyles = `<a:fillStyleLst><a:solidFill>${scheme(9)}</a:solidFill>${gradients[0] ?? ''}${gradients[1] ?? ''}</a:fillStyleLst>`;
  const backgroundFills = `<a:bgFillStyleLst><a:solidFill>${scheme(10)}</a:solidFill><a:solidFill>${scheme(11)}</a:solidFill>${gradients[2] ?? ''}</a:bgFillStyleLst>`;
  const lines = `<a:lnStyleLst>${Array.from({ length: 3 }, (_unused, index) => `<a:ln w="${String(6350 + index)}" cap="flat" cmpd="sng" algn="ctr"><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join('')}</a:lnStyleLst>`;
  const effects = `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>`;
  return `<?xml version="1.0" encoding="UTF-8"?><a:theme xmlns:a="${drawingNamespace}" name="Office Theme"><a:themeElements><a:clrScheme name="Office">${colorScheme}</a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri" panose="020F0502020204030204"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme>${fillStyles}${lines}${effects}${backgroundFills}</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

async function writeSyntheticDocx(entries: readonly SyntheticZipEntry[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-'));
  roots.push(root);
  const path = join(root, 'document.docx');
  await writeFile(path, zip(entries));
  return path;
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
    algorithmVersion: '0.3.0',
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, unknown>>)[key])}`).join(',')}}`;
}

function stableIdentifier(prefix: 'plan' | 'act', value: unknown): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = createHash('sha256').update(canonicalJson(value)).digest().subarray(0, 16);
  let numeric = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = `${alphabet.charAt(Number(numeric & 31n))}${encoded}`;
    numeric >>= 5n;
  }
  return `${prefix}_${encoded}`;
}

function withReplacement(plan: TypedLabelPlan, replacement: string): TypedLabelPlan {
  if (plan.schemaVersion !== '1.0.0') throw new Error('Synthetic DOCX plan must use v1.');
  const original = plan.actions[0];
  if (original === undefined) throw new Error('Synthetic DOCX plan requires one action.');
  const { id: _oldActionId, ...oldActionWithoutId } = original;
  void _oldActionId;
  const actionWithoutId = { ...oldActionWithoutId, replacement };
  const action = {
    ...actionWithoutId,
    id: stableIdentifier('act', {
      resolutionDigest: plan.resolutionDigest,
      policyDigest: plan.policy.digest,
      action: actionWithoutId
    })
  };
  const { digest: _oldDigest, id: _oldPlanId, ...oldPlanWithoutIdentity } = plan;
  void _oldDigest;
  void _oldPlanId;
  const planWithoutIdentity = { ...oldPlanWithoutIdentity, actions: [action] };
  const id = stableIdentifier('plan', planWithoutIdentity);
  const digest = parseSha256Digest(`sha256:${createHash('sha256').update(canonicalJson({ id, ...planWithoutIdentity })).digest('hex')}`);
  return Object.freeze({ ...planWithoutIdentity, id, digest });
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

  it('maps a structural tab to a canonical boundary and distinct native segments', async () => {
    const path = await docxFile(documentXml('<w:p><w:r><w:t>left-canary</w:t><w:tab/><w:t>right-canary</w:t></w:r></w:p>'));

    const artifact = await readDocxArtifact(path);

    expect(artifact.text).toBe('left-canary\n\u0000\nright-canary');
    expect(artifact.regions.map(({ location }) => location)).toEqual([
      { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 1 },
      { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 1 }
    ]);
    const session = createLocalDocxArtifactSession(path, join(roots.at(-1) ?? '', 'document.redacted.docx'));
    await expect(session.stage(planFor(artifact, [{ start: 0, end: unicodeCodePointLength(artifact.text) }])))
      .rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
  });

  it('extracts supported text parts in deterministic semantic order with value-free native regions', async () => {
    const parts: SupportedTextPart[] = [
      { id: 'rId5', kind: 'endnotes', name: 'endnotes.xml', contents: `<?xml version="1.0" encoding="UTF-8"?><w:endnotes xmlns:w="${wordNamespace}"><w:endnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:endnote><w:endnote w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote><w:endnote w:id="1"><w:p><w:r><w:t>endnote-canary</w:t></w:r></w:p></w:endnote></w:endnotes>` },
      { id: 'rId3', kind: 'footer', name: 'footer1.xml', contents: `<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>footer-canary</w:t></w:r></w:p></w:ftr>` },
      { id: 'rId2', kind: 'header', name: 'header2.xml', contents: `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>header-two-canary</w:t></w:r></w:p></w:hdr>` },
      { id: 'rId4', kind: 'footnotes', name: 'footnotes.xml', contents: `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="${wordNamespace}"><w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>footnote-canary</w:t></w:r></w:p></w:footnote></w:footnotes>` },
      { id: 'rId1', kind: 'header', name: 'header1.xml', contents: `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>header-one-canary</w:t></w:r></w:p></w:hdr>` }
    ];
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:r><w:t>document-canary</w:t><w:footnoteReference w:id="1"/><w:endnoteReference w:id="1"/></w:r></w:p><w:sectPr><w:headerReference r:id="rId1" w:type="default"/><w:headerReference r:id="rId2" w:type="even"/><w:footerReference r:id="rId3" w:type="default"/></w:sectPr></w:body></w:document>`;
    const path = await writeSyntheticDocx(supportedPackageParts(document, parts));

    const first = await readDocxArtifact(path);
    const second = await readDocxArtifact(path);

    expect(first.text).toBe([
      'document-canary', 'header-one-canary', 'header-two-canary', 'footer-canary', 'footnote-canary', 'endnote-canary'
    ].join('\n\u0000\n'));
    expect(first.regions.map(({ location }) => location.kind === 'DOCX_PART' ? location.part : '')).toEqual([
      'word/document.xml', 'word/header1.xml', 'word/header2.xml', 'word/footer1.xml', 'word/footnotes.xml', 'word/endnotes.xml'
    ]);
    expect(second.extractionRevision).toBe(first.extractionRevision);
  });

  it('accepts exact passive Office theme and empty web-settings profiles without adding canonical text', async () => {
    const document = documentXml('<w:p><w:r><w:t>safe-visible-text</w:t></w:r></w:p>');
    const path = await writeSyntheticDocx(passivePackageParts(document, passiveTheme(), passiveWebSettings()));

    const artifact = await readDocxArtifact(path);

    expect(artifact.text).toBe('safe-visible-text');
    expect(artifact.regions).toHaveLength(1);
  });

  it('maps an external HTTPS hyperlink target as an isolated v2 relationship region without dereferencing it', async () => {
    const target = 'https://private-canary.invalid/profile';
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:hyperlink r:id="rId2"><w:r><w:t>safe label</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`;
    const entries = packageParts(document, [{
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}hyperlink" Target="${target}" TargetMode="External"/></Relationships>`
    }]);
    const path = await writeSyntheticDocx(entries);

    const artifact = await readDocxArtifact(path);

    expect(artifact.text).toContain(target);
    expect(artifact.regions.at(-1)).toMatchObject({
      schemaVersion: '2.0.0',
      location: { schemaVersion: '2.0.0', kind: 'DOCX_RELATIONSHIP', sourcePart: 'word/document.xml', relationshipId: 'rId2', field: 'TARGET' }
    });
  });

  it('maps resume-shaped support parts and rejects hidden, wrong-parent, reordered, self-closing, and empty-identity profiles', async () => {
    const namespaces = `xmlns:w="${wordNamespace}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"`;
    const parts = [
      { kind: 'settings', name: 'settings.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml', contents: `<w:settings ${namespaces}><w:compat><w:compatSetting w:name="private-settings-canary" w:uri="https://private-canary.invalid/settings" w:val="safe-profile"/></w:compat></w:settings>` },
      { kind: 'numbering', name: 'numbering.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml', contents: `<w:numbering xmlns:w="${wordNamespace}"><w:abstractNum w:abstractNumId="1"><w:nsid w:val="00000001"/><w:multiLevelType w:val="single"/><w:tmpl w:val="00000001"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="2025550100"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="left" w:pos="1"/></w:tabs><w:ind w:left="1"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>` },
      { kind: 'styles', name: 'styles.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', contents: `<w:styles xmlns:w="${wordNamespace}"><w:style w:type="paragraph" w:styleId="private-style-canary"><w:name w:val="private-style-name-canary"/><w:rPr><w:color w:val="112233"/></w:rPr></w:style></w:styles>` }
    ];
    const overrides = parts.map((part) => `<Override PartName="/word/${part.name}" ContentType="${part.type}"/>`).join('');
    const relationships = parts.map((part, index) => `<Relationship Id="rId${String(index + 2)}" Type="${officeRelationshipPrefix}${part.kind}" Target="${part.name}"/>`).join('');
    const entries: SyntheticZipEntry[] = [
      { name: '[Content_Types].xml', contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/>${overrides}</Types>` },
      { name: '_rels/.rels', contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>` },
      { name: 'word/document.xml', contents: documentXml('<w:p><w:r><w:t>safe visible text</w:t></w:r></w:p>') },
      { name: 'word/_rels/document.xml.rels', contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}">${relationships}</Relationships>` },
      ...parts.map((part) => ({ name: `word/${part.name}`, contents: part.contents }))
    ];
    const path = await writeSyntheticDocx(entries);
    const artifact = await readDocxArtifact(path);
    expect(artifact.text).toContain('private-settings-canary');
    expect(artifact.text).toContain('2025550100');
    expect(artifact.text).toContain('private-style-name-canary');
    expect(artifact.text).not.toContain('112233');
    expect(artifact.regions.filter(({ location }) => location.kind === 'DOCX_XML_VALUE').length).toBeGreaterThanOrEqual(3);

    const hidden = entries.map((entry) => entry.name === 'word/styles.xml'
      ? { ...entry, contents: String(entry.contents).replace('</w:style>', '<w:rPr><w:vanish w:val="private-hidden-canary"/></w:rPr></w:style>') }
      : entry);
    try {
      await readDocxArtifact(await writeSyntheticDocx(hidden));
      throw new Error('Expected hidden-style rejection.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'metadata_part' } });
      expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details })).not.toContain('private-hidden-canary');
    }

    const malformedGraphs = [
      entries.map((entry) => entry.name === 'word/numbering.xml'
        ? { ...entry, contents: String(entry.contents).replace('<w:lvl w:ilvl="0">', '<w:lvlText w:val="private-parent-canary"/><w:lvl w:ilvl="0">') }
        : entry),
      entries.map((entry) => entry.name === 'word/numbering.xml'
        ? { ...entry, contents: String(entry.contents).replace('<w:start w:val="1"/><w:numFmt w:val="decimal"/>', '<w:numFmt w:val="decimal"/><w:start w:val="1"/>') }
        : entry),
      entries.map((entry) => entry.name === 'word/numbering.xml'
        ? { ...entry, contents: String(entry.contents).replace('<w:start w:val="1"/>', '<w:start w:val="private-structural-canary"/>') }
        : entry),
      entries.map((entry) => entry.name === 'word/numbering.xml'
        ? { ...entry, contents: String(entry.contents).replace('<w:numFmt w:val="decimal"/>', '<w:numFmt w:val="2025550100"/>') }
        : entry),
      entries.map((entry) => entry.name === 'word/styles.xml'
        ? { ...entry, contents: String(entry.contents).replace('<w:color w:val="112233"/>', '<w:color w:val="2025550100"/>') }
        : entry),
      entries.map((entry) => entry.name === 'word/styles.xml'
        ? { ...entry, contents: String(entry.contents).replace('<w:style w:type="paragraph" w:styleId="private-style-canary"><w:name w:val="private-style-name-canary"/><w:rPr><w:color w:val="112233"/></w:rPr></w:style>', '<w:style w:type="paragraph" w:styleId="private-cardinality-canary"/>') }
        : entry),
      entries.map((entry) => entry.name === 'word/styles.xml'
        ? { ...entry, contents: String(entry.contents).replace('w:styleId="private-style-canary"', 'w:styleId=""') }
        : entry)
    ];
    for (const malformed of malformedGraphs) {
      try {
        await readDocxArtifact(await writeSyntheticDocx(malformed));
        throw new Error('Expected support-part graph rejection.');
      } catch (error: unknown) {
        expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'metadata_part' } });
        expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details })).not.toMatch(/private-structural-canary|2025550100/u);
      }
    }
  });

  it.each([
    ['paragraph identifier', 'w14:paraId'],
    ['paragraph text identifier', 'w14:textId'],
    ['revision identifier', 'w:rsidRDefault']
  ])('rejects a phone-shaped %s instead of omitting it as structural data', async (_label, attribute) => {
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p ${attribute}="2025550100"><w:r><w:t>safe</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
    try {
      await readDocxArtifact(await docxFile(document));
      throw new Error('Expected malformed generated identifier rejection.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'unknown_feature' } });
      expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details })).not.toContain('2025550100');
    }
  });

  it('maps font/property carriers and rejects extra roots, vector mismatches, empty variants, and repeated vectors', async () => {
    const coreType = 'application/vnd.openxmlformats-package.core-properties+xml';
    const appType = 'application/vnd.openxmlformats-officedocument.extended-properties+xml';
    const fontType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml';
    const entries: SyntheticZipEntry[] = [
      { name: '[Content_Types].xml', contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/fontTable.xml" ContentType="${fontType}"/><Override PartName="/docProps/core.xml" ContentType="${coreType}"/><Override PartName="/docProps/app.xml" ContentType="${appType}"/></Types>` },
      { name: '_rels/.rels', contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${officeRelationshipPrefix}extended-properties" Target="docProps/app.xml"/></Relationships>` },
      { name: 'word/document.xml', contents: documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>') },
      { name: 'word/_rels/document.xml.rels', contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}fontTable" Target="fontTable.xml"/></Relationships>` },
      { name: 'word/fontTable.xml', contents: `<w:fonts xmlns:w="${wordNamespace}"><w:font w:name="private-font-canary"><w:altName w:val="private-font-alias-canary"/><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/><w:family w:val="auto"/><w:pitch w:val="default"/></w:font></w:fonts>` },
      { name: 'docProps/core.xml', contents: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>private-core-canary</dc:creator></cp:coreProperties>' },
      { name: 'docProps/app.xml', contents: '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>private-app-canary</Application><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>private-heading-canary</vt:lpstr></vt:variant><vt:variant><vt:i4>1</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>private-title-canary</vt:lpstr></vt:vector></TitlesOfParts><Company>private-company-canary</Company></Properties>' }
    ];
    const artifact = await readDocxArtifact(await writeSyntheticDocx(entries));
    expect(artifact.text).toContain('private-font-canary');
    expect(artifact.text).toContain('private-core-canary');
    expect(artifact.text).toContain('private-app-canary');
    expect(artifact.regions.some(({ location }) => location.kind === 'DOCX_XML_VALUE' && location.part === 'docProps/app.xml' && location.element === 'Application')).toBe(true);

    const malformedProperties = [
      entries.map((entry) => entry.name === 'docProps/core.xml'
        ? { ...entry, contents: String(entry.contents).replace('<cp:coreProperties ', '<cp:coreProperties xmlns:private="https://private-namespace-canary.invalid" ') }
        : entry),
      entries.map((entry) => entry.name === 'docProps/app.xml'
        ? { ...entry, contents: String(entry.contents).replace('<Properties ', '<Properties privateRoot="2025550100" ') }
        : entry),
      entries.map((entry) => entry.name === 'docProps/app.xml'
        ? { ...entry, contents: String(entry.contents).replace('size="2" baseType="variant"', 'size="3" baseType="variant"') }
        : entry),
      entries.map((entry) => entry.name === 'docProps/app.xml'
        ? { ...entry, contents: String(entry.contents).replace('<vt:variant><vt:i4>1</vt:i4></vt:variant>', '<vt:variant/>') }
        : entry),
      entries.map((entry) => entry.name === 'docProps/app.xml'
        ? { ...entry, contents: String(entry.contents).replace('</HeadingPairs>', '<vt:vector size="1" baseType="variant"><vt:variant><vt:lpstr>private-vector-canary</vt:lpstr></vt:variant></vt:vector></HeadingPairs>') }
        : entry),
      entries.map((entry) => entry.name === 'docProps/app.xml'
        ? { ...entry, contents: String(entry.contents).replace('<Application>', '<Application foo="2025550100">') }
        : entry)
    ];
    for (const malformed of malformedProperties) {
      try {
        await readDocxArtifact(await writeSyntheticDocx(malformed));
        throw new Error('Expected property-profile rejection.');
      } catch (error: unknown) {
        expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'metadata_part' } });
        expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details })).not.toMatch(/private-(?:namespace|vector)-canary|2025550100/u);
      }
    }
  });

  it('accepts only zero-text decorative AlternateContent and maps its retained shape name', async () => {
    const body = `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="1" name="private-shape-canary"/><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:prstGeom prst="line"><a:avLst/></a:prstGeom></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:line wp14:anchorId="00AABBCC"/><w10:wrap/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:mc="${markupCompatibilityNamespace}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:a="${drawingNamespace}" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w10="urn:schemas-microsoft-com:office:word"><w:body>${body}<w:sectPr/></w:body></w:document>`;
    const artifact = await readDocxArtifact(await docxFile(document));
    expect(artifact.text).toContain('private-shape-canary');
    expect(artifact.text).not.toContain('00AABBCC');
    expect(artifact.regions.some(({ location }) => location.kind === 'DOCX_XML_VALUE' && location.element === 'wp:docPr')).toBe(true);

    try {
      await readDocxArtifact(await docxFile(document.replace('00AABBCC', 'private-structural-canary')));
      throw new Error('Expected malformed VML anchor identifier rejection.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'unknown_feature' } });
      expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details })).not.toContain('private-structural-canary');
    }
  });

  it.each([
    ['attribute canary', (theme: string) => theme.replace('name="Office Theme"', 'name="private-canary"')],
    ['missing required element', (theme: string) => theme.replace('<a:extraClrSchemeLst/>', '')],
    ['wrong top-level order', (theme: string) => theme.replace('<a:objectDefaults/><a:extraClrSchemeLst/>', '<a:extraClrSchemeLst/><a:objectDefaults/>')],
    ['namespace prefix rebinding', (theme: string) => theme.replace(drawingNamespace, 'urn:private-canary')]
  ])('rejects a passive theme with %s using a privacy-safe error', async (_name, mutate) => {
    const document = documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>');
    const path = await writeSyntheticDocx(passivePackageParts(document, mutate(passiveTheme()), passiveWebSettings()));
    try {
      await readDocxArtifact(path);
      throw new Error('Expected passive theme rejection.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'metadata_part' } });
      expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details })).not.toContain('private-canary');
    }
  });

  it.each([
    ['orphan theme part', 'FORMAT_CORRUPT', (entries: SyntheticZipEntry[]) => entries.map((entry) => entry.name === 'word/_rels/document.xml.rels' ? { ...entry, contents: String(entry.contents).replace(/<Relationship Id="rId2"[^>]+\/>/u, '') } : entry)],
    ['wrong theme relationship type', 'FORMAT_UNSUPPORTED', (entries: SyntheticZipEntry[]) => entries.map((entry) => entry.name === 'word/_rels/document.xml.rels' ? { ...entry, contents: String(entry.contents).replace(`${officeRelationshipPrefix}theme`, `${officeRelationshipPrefix}styles`) } : entry)],
    ['wrong theme content type', 'FORMAT_CORRUPT', (entries: SyntheticZipEntry[]) => entries.map((entry) => entry.name === '[Content_Types].xml' ? { ...entry, contents: String(entry.contents).replace('application/vnd.openxmlformats-officedocument.theme+xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml') } : entry)]
  ])('rejects %s in the passive-part graph', async (_name, code, mutate) => {
    const entries = passivePackageParts(documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>'), passiveTheme(), passiveWebSettings());
    const path = await writeSyntheticDocx(mutate(entries));
    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code });
  });

  it.each([
    ['raw XML control', '\u0001'],
    ['numeric XML control entity', '&#1;']
  ])('rejects a %s before returning planted text', async (_name, planted) => {
    const path = await docxFile(documentXml(`<w:p><w:r><w:t>private-canary${planted}</w:t></w:r></w:p>`));
    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
  });

  it('rejects an integrity-valid plan containing an XML-invalid replacement before staging', async () => {
    const input = await docxFile(documentXml('<w:p><w:r><w:t>alpha@example.test</w:t></w:r></w:p>'));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const plan = planFor(source, [{ start: 0, end: unicodeCodePointLength(source.text) }]);
    const invalidReplacementPlan = withReplacement(plan, '[EMAIL_1]\u0001');

    expect(() => { assertTypedLabelPlanIntegrity(invalidReplacementPlan); }).not.toThrow();
    await expect(session.stage(invalidReplacementPlan)).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    expect(await readdir(root)).toEqual(['document.docx']);
  });

  it('accepts bounded Microsoft-produced DEFLATE flags and a strictly shaped OPC growth hint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-'));
    roots.push(root);
    const path = join(root, 'document.docx');
    const parts = packageParts(documentXml('<w:p><w:r><w:t>alpha@example.test</w:t></w:r></w:p>'));
    await writeFile(path, zip(parts.map((entry, index): SyntheticZipEntry => ({
      ...entry,
      flags: 0x0006,
      ...(index === 0 ? { localExtra: growthHint(64) } : {})
    }))));

    const artifact = await readDocxArtifact(path);

    expect(artifact.text).toBe('alpha@example.test');
  });

  it.each([
    ['wrong growth-hint signature', (() => { const extra = growthHint(8); extra.writeUInt16LE(0, 4); return extra; })()],
    ['inconsistent growth-hint length', (() => { const extra = growthHint(8); extra.writeUInt16LE(7, 6); return extra; })()],
    ['nonzero growth-hint padding', (() => { const extra = growthHint(8); extra[8] = 1; return extra; })()],
    ['unknown local extra field', (() => { const extra = growthHint(8); extra.writeUInt16LE(0x9999, 0); return extra; })()]
  ])('rejects %s without interpreting extra-field payloads', async (_name, localExtra) => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-'));
    roots.push(root);
    const path = join(root, 'document.docx');
    const parts = packageParts(documentXml('<w:p><w:r><w:t>synthetic-canary</w:t></w:r></w:p>'));
    const first = parts[0];
    if (first === undefined) throw new Error('Synthetic package is incomplete.');
    await writeFile(path, zip([{ ...first, localExtra }, ...parts.slice(1)]));

    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
  });

  it('rejects a header reference bound to a footer relationship', async () => {
    const footer: SupportedTextPart = {
      id: 'rId2',
      kind: 'footer',
      name: 'footer1.xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><w:ftr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>private-canary</w:t></w:r></w:p></w:ftr>`
    };
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:r><w:t>safe</w:t></w:r></w:p><w:sectPr><w:headerReference r:id="rId2" w:type="default"/></w:sectPr></w:body></w:document>`;
    const path = await writeSyntheticDocx(supportedPackageParts(document, [footer]));

    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
  });

  it.each([
    ['encrypted', 0x0001],
    ['data descriptor', 0x0008],
    ['reserved flag', 0x0010]
  ])('rejects the %s ZIP flag', async (_name, flags) => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-'));
    roots.push(root);
    const path = join(root, 'document.docx');
    await writeFile(path, zip(packageParts(documentXml('<w:p><w:r><w:t>synthetic-canary</w:t></w:r></w:p>')).map((entry) => ({ ...entry, flags }))));

    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
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

  it('reconciles a paragraph action against the exact stage while retaining every untouched carrier and part', async () => {
    const target = 'https://synthetic.invalid/profile';
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:r><w:t>alpha@example.test</w:t></w:r><w:hyperlink r:id="rId2"><w:r><w:t>safe label</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`;
    const input = await writeSyntheticDocx(packageParts(document, [{
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}hyperlink" Target="${target}" TargetMode="External"/></Relationships>`
    }]));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const value = 'alpha@example.test';
    const start = codePointOffsetOf(source.text, value);
    const plan = planFor(source, [{ start, end: start + unicodeCodePointLength(value) }]);
    const staged = await session.stage(plan);

    const evidence = await reconcileDocxStageFoundation(source, staged, plan);

    expect(evidence).toMatchObject({
      outcome: 'RECONCILED_NONINDEPENDENT',
      expectedActionCount: 1,
      appliedActionCount: 1,
      retainedCarrierCount: 1,
      changedPartCount: 1,
      unchangedPartCount: 3,
      uniqueSourceCanaryCount: 1,
      independentlyVerified: false,
      fidelityVerified: false
    });
    expect(evidence.checks).toContain('UNTOUCHED_PART_CONTENT_IDENTITY');
    expect(docxAdapterCapabilityDescriptor.operations).not.toContain('REDACT');
    expect(docxAdapterCapabilityDescriptor.operations).not.toContain('VERIFY');
    await session.discard(staged);
  });

  it('writes and reconciles a plan targeting an accepted relationship carrier', async () => {
    const target = 'https://synthetic.invalid/private@example.test';
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:hyperlink r:id="rId2"><w:r><w:t>safe label</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`;
    const input = await writeSyntheticDocx(packageParts(document, [{
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}hyperlink" Target="${target}" TargetMode="External"/></Relationships>`
    }]));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const start = codePointOffsetOf(source.text, 'private@example.test');

    const plan = planFor(source, [{
      start,
      end: start + unicodeCodePointLength('private@example.test')
    }]);
    const staged = await session.stage(plan);

    expect((await session.reopen(staged)).text).toContain('https://synthetic.invalid/[EMAIL_1]');
    await expect(reconcileDocxStageFoundation(source, staged, plan)).resolves.toMatchObject({
      outcome: 'RECONCILED_NONINDEPENDENT',
      retainedCarrierCount: 1,
      changedPartCount: 1
    });
    await session.discard(staged);
    await expect(session.stage(planFor(source, [{ start: 0, end: unicodeCodePointLength(source.text) }])))
      .rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    expect(await readdir(root)).toEqual(['document.docx']);
  });

  it('writes relationship, Word-attribute, and property-text carriers in one exact multi-part plan', async () => {
    const relationshipValue = 'relationship@example.test';
    const propertyValue = 'property@example.test';
    const attributeValue = 'attribute@example.test';
    const settingsNamespaces = `xmlns:w="${wordNamespace}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"`;
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:hyperlink r:id="rId3"><w:r><w:t>safe label</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`;
    const entries: SyntheticZipEntry[] = [
      { name: '[Content_Types].xml', contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
      { name: '_rels/.rels', contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
      { name: 'word/document.xml', contents: document },
      { name: 'word/_rels/document.xml.rels', contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}settings" Target="settings.xml"/><Relationship Id="rId3" Type="${officeRelationshipPrefix}hyperlink" Target="mailto:${relationshipValue}" TargetMode="External"/></Relationships>` },
      { name: 'word/settings.xml', contents: `<w:settings ${settingsNamespaces}><w:compat><w:compatSetting w:name="${attributeValue}" w:uri="https://synthetic.invalid/settings" w:val="safe-profile"/></w:compat></w:settings>` },
      { name: 'docProps/core.xml', contents: `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${propertyValue}</dc:creator></cp:coreProperties>` }
    ];
    const input = await writeSyntheticDocx(entries);
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const spans = [relationshipValue, propertyValue, attributeValue].map((value) => {
      const start = codePointOffsetOf(source.text, value);
      return { start, end: start + unicodeCodePointLength(value) };
    });
    const plan = planFor(source, spans);
    const staged = await session.stage(plan);
    const reopened = await session.reopen(staged);

    expect(reopened.text).not.toMatch(/relationship@example\.test|property@example\.test|attribute@example\.test/u);
    expect(reopened.text).toContain('mailto:[EMAIL_1]');
    expect(reopened.text).toContain('[EMAIL_2]');
    expect(reopened.text).toContain('[EMAIL_3]');
    await expect(reconcileDocxStageFoundation(source, staged, plan)).resolves.toMatchObject({
      outcome: 'RECONCILED_NONINDEPENDENT',
      expectedActionCount: 3,
      appliedActionCount: 3,
      retainedCarrierCount: 5,
      changedPartCount: 3,
      unchangedPartCount: 3,
      uniqueSourceCanaryCount: 3
    });
    await session.discard(staged);
    expect(await readdir(root)).toEqual(['document.docx']);
  });

  it.each(['"', "'"] as const)('XML-escapes a %s-quoted carrier replacement across astral and interior action boundaries', async (quote) => {
    const carrierValue = '😀attribute@example.test-tail';
    const selected = 'attribute@example.test';
    const replacement = `label&<>"'😀`;
    const settingsNamespaces = `xmlns:w="${wordNamespace}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"`;
    const entries: SyntheticZipEntry[] = [
      { name: '[Content_Types].xml', contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>` },
      { name: '_rels/.rels', contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>` },
      { name: 'word/document.xml', contents: documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>') },
      { name: 'word/_rels/document.xml.rels', contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}settings" Target="settings.xml"/></Relationships>` },
      { name: 'word/settings.xml', contents: `<w:settings ${settingsNamespaces}><w:compat><w:compatSetting w:name=${quote}${carrierValue}${quote} w:uri="https://synthetic.invalid/settings" w:val="safe-profile"/></w:compat></w:settings>` }
    ];
    const input = await writeSyntheticDocx(entries);
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const start = codePointOffsetOf(source.text, selected);
    const plan = withReplacement(planFor(source, [{ start, end: start + unicodeCodePointLength(selected) }]), replacement);
    const staged = await session.stage(plan);
    const reopened = await session.reopen(staged);

    expect(reopened.text).toContain(`😀${replacement}-tail`);
    await expect(reconcileDocxStageFoundation(source, staged, plan)).resolves.toMatchObject({
      outcome: 'RECONCILED_NONINDEPENDENT',
      expectedActionCount: 1,
      retainedCarrierCount: 3,
      changedPartCount: 1
    });
    await session.discard(staged);
  });

  it('writes a retained drawing attribute carrier in the same package part as visible Word content', async () => {
    const selected = 'private-shape@example.test';
    const body = `<w:p><w:r><w:t>safe visible text</w:t></w:r></w:p><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wp:docPr id="1" name="${selected}"/><a:graphic><a:graphicData><wps:wsp><wps:spPr><a:prstGeom prst="line"><a:avLst/></a:prstGeom></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:line wp14:anchorId="00AABBCC"/><w10:wrap/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>`;
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:mc="${markupCompatibilityNamespace}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:a="${drawingNamespace}" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w10="urn:schemas-microsoft-com:office:word"><w:body>${body}<w:sectPr/></w:body></w:document>`;
    const input = await docxFile(document);
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const start = codePointOffsetOf(source.text, selected);
    const plan = planFor(source, [{ start, end: start + unicodeCodePointLength(selected) }]);
    const staged = await session.stage(plan);

    expect((await session.reopen(staged)).text).toContain('[EMAIL_1]');
    await expect(reconcileDocxStageFoundation(source, staged, plan)).resolves.toMatchObject({
      outcome: 'RECONCILED_NONINDEPENDENT',
      expectedActionCount: 1,
      changedPartCount: 1
    });
    await session.discard(staged);
  });

  it('rejects a carrier replacement that would invalidate the closed relationship grammar before staging', async () => {
    const target = 'https://synthetic.invalid/profile';
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:hyperlink r:id="rId2"><w:r><w:t>safe label</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`;
    const input = await writeSyntheticDocx(packageParts(document, [{
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}hyperlink" Target="${target}" TargetMode="External"/></Relationships>`
    }]));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const start = codePointOffsetOf(source.text, target);

    await expect(session.stage(planFor(source, [{ start, end: start + unicodeCodePointLength(target) }])))
      .rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'external_relationship' } });
    expect(await readdir(root)).toEqual(['document.docx']);
  });

  it('detects a changed retained carrier in the exact staged-byte reconciliation without exposing its value', async () => {
    const originalTarget = 'https://synthetic.invalid/original-carrier-canary';
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:r><w:t>alpha@example.test</w:t></w:r><w:hyperlink r:id="rId2"><w:r><w:t>safe label</w:t></w:r></w:hyperlink></w:p><w:sectPr/></w:body></w:document>`;
    const relationship = (target: string) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}hyperlink" Target="${target}" TargetMode="External"/></Relationships>`;
    const input = await writeSyntheticDocx(packageParts(document, [{ name: 'word/_rels/document.xml.rels', contents: relationship(originalTarget) }]));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const plan = planFor(source, [{ start: 0, end: unicodeCodePointLength('alpha@example.test') }]);
    const staged = await session.stage(plan);
    const tamperedDocument = document.replace('alpha@example.test', '[EMAIL_1]');
    await writeFile(staged.path, zip(packageParts(tamperedDocument, [{
      name: 'word/_rels/document.xml.rels',
      contents: relationship('https://synthetic.invalid/changed-carrier-canary')
    }])));

    try {
      await reconcileDocxStageFoundation(source, staged, plan);
      throw new Error('Expected changed-carrier reconciliation failure.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'VERIFICATION_INCOMPLETE', details: { reason: 'writer_byte_mismatch' } });
      expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details }))
        .not.toMatch(/original-carrier-canary|changed-carrier-canary/u);
    }
    await session.discard(staged);
  });

  it('does not treat an intentionally retained duplicate value as a unique planted canary', async () => {
    const value = 'alpha@example.test';
    const input = await docxFile(documentXml(`<w:p><w:r><w:t>${value} ${value}</w:t></w:r></w:p>`));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const plan = planFor(source, [{ start: 0, end: unicodeCodePointLength(value) }]);
    const staged = await session.stage(plan);

    const evidence = await reconcileDocxStageFoundation(source, staged, plan);

    expect(evidence.uniqueSourceCanaryCount).toBe(0);
    expect((await session.reopen(staged)).text).toBe(`[EMAIL_1] ${value}`);
    await session.discard(staged);
  });

  it('does not misclassify an overlapping duplicate source value as a unique planted canary', async () => {
    const input = await docxFile(documentXml('<w:p><w:r><w:t>aaaa</w:t></w:r></w:p>'));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const plan = planFor(source, [{ start: 0, end: 3 }]);
    const staged = await session.stage(plan);

    const evidence = await reconcileDocxStageFoundation(source, staged, plan);

    expect(evidence.uniqueSourceCanaryCount).toBe(0);
    await session.discard(staged);
  });

  it('rejects a forged writer receipt before treating a private DOCX stage as reconciled', async () => {
    const input = await docxFile(documentXml('<w:p><w:r><w:t>alpha@example.test</w:t></w:r></w:p>'));
    const root = roots.at(-1) ?? '';
    const session = createLocalDocxArtifactSession(input, join(root, 'document.redacted.docx'));
    const source = await session.input();
    const plan = planFor(source, [{ start: 0, end: unicodeCodePointLength(source.text) }]);
    const staged = await session.stage(plan);
    const forged = { ...staged, receipt: { ...staged.receipt, appliedActionIds: [] } };

    await expect(reconcileDocxStageFoundation(source, forged, plan)).rejects.toMatchObject({
      code: 'VERIFICATION_INCOMPLETE',
      details: { reason: 'receipt_binding_mismatch' }
    });
    await session.discard(staged);
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
    ['hidden text', '<w:p><w:r><w:rPr><w:vanish/></w:rPr><w:t>private-canary</w:t></w:r></w:p>', [], 'unknown_feature'],
    ['revision', '<w:p><w:ins><w:r><w:t>private-canary</w:t></w:r></w:ins></w:p>', [], 'unknown_feature'],
    ['field', '<w:p><w:r><w:instrText>private-canary</w:instrText></w:r></w:p>', [], 'unknown_feature'],
    ['drawing', '<w:p><w:r><w:drawing/></w:r></w:p>', [], 'drawing_or_alternate_content'],
    ['AlternateContent', '<w:p><w:r><mc:AlternateContent><w:t>private-canary</w:t></mc:AlternateContent></w:r></w:p>', [], 'drawing_or_alternate_content'],
    ['unknown Word element', '<w:p><w:unknown><w:r><w:t>private-canary</w:t></w:r></w:unknown></w:p>', [], 'unknown_feature'],
    ['unknown numeric-looking paragraph attribute', '<w:p w:val="2025550100"><w:r><w:t>private-canary</w:t></w:r></w:p>', [], 'unknown_feature'],
    ['invalid known-element nesting', '<w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>private-canary</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:p>', [], 'unknown_feature'],
    ['character data outside w:t', '<w:p>private-canary<w:r><w:t>safe</w:t></w:r></w:p>', [], 'unknown_feature'],
    ['XML comment', '<!-- private-canary --><w:p><w:r><w:t>safe</w:t></w:r></w:p>', [], 'unknown_feature'],
    ['styles part', '<w:p><w:r><w:t>safe</w:t></w:r></w:p>', [{ name: 'word/styles.xml', contents: '<w:styles xmlns:w="urn:test"><w:style><w:name w:val="private-canary"/></w:style></w:styles>' }], 'metadata_part'],
    ['comments part', '<w:p><w:r><w:t>safe</w:t></w:r></w:p>', [{ name: 'word/comments.xml', contents: 'private-canary' }], 'additional_text_part']
  ])('fails closed for %s without exposing planted content', async (_name, body, additions, reason) => {
    const path = await docxFile(documentXml(body), additions);
    try {
      await readDocxArtifact(path);
      throw new Error('Expected the synthetic DOCX to be rejected.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason } });
      const envelope = JSON.stringify({
        code: (error as { code?: unknown }).code,
        message: (error as Error).message,
        details: (error as { details?: unknown }).details
      });
      expect(envelope).not.toContain('private-canary');
      expect(envelope).not.toContain(path);
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
    await expect(readDocxArtifact(path)).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
      details: { reason: 'external_relationship' }
    });
  });

  it('rejects an external main-document relationship with a closed value-free reason', async () => {
    const header: SupportedTextPart = {
      id: 'rId2',
      kind: 'header',
      name: 'header1.xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>private-canary</w:t></w:r></w:p></w:hdr>`
    };
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:r><w:t>safe</w:t></w:r></w:p><w:sectPr><w:headerReference r:id="rId2" w:type="default"/></w:sectPr></w:body></w:document>`;
    const entries = supportedPackageParts(document, [header]).map((entry) => entry.name === 'word/_rels/document.xml.rels'
      ? { ...entry, contents: String(entry.contents).replace(' Target="header1.xml"', ' Target="https://private-canary.invalid/header.xml" TargetMode="External"') }
      : entry);
    const path = await writeSyntheticDocx(entries);

    await expect(readDocxArtifact(path)).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
      details: { reason: 'external_relationship' }
    });
  });

  it.each([
    ['missing header reference', false, supportedPartContentTypes.header],
    ['wrong header content type', true, supportedPartContentTypes.footer]
  ])('rejects a %s in the supported part graph', async (_name, includeReference, contentType) => {
    const header: SupportedTextPart = {
      id: 'rId2',
      kind: 'header',
      name: 'header1.xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="${wordNamespace}"><w:p><w:r><w:t>private-canary</w:t></w:r></w:p></w:hdr>`
    };
    const reference = includeReference ? '<w:headerReference r:id="rId2" w:type="default"/>' : '';
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body><w:p><w:r><w:t>safe</w:t></w:r></w:p><w:sectPr>${reference}</w:sectPr></w:body></w:document>`;
    const entries = supportedPackageParts(document, [header]).map((entry) => entry.name === '[Content_Types].xml'
      ? { ...entry, contents: String(entry.contents).replace(supportedPartContentTypes.header, contentType) }
      : entry);
    const path = await writeSyntheticDocx(entries);

    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
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
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}"><w:body ${Array.from({ length: 65 }, (_, index) => `a${String(index)}="x"`).join(' ')}/></w:document>`
    ]
  ])('rejects %s within the bounded XML scanner', async (_name, document) => {
    const path = await docxFile(document);
    await expect(readDocxArtifact(path)).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
  });

  it('classifies a bounded Word namespace inventory as unsupported rather than corrupt', async () => {
    const namespaces = Array.from({ length: 36 }, (_, index) => `xmlns:q${String(index)}="urn:synthetic:${String(index)}"`).join(' ');
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" ${namespaces}><w:body><w:p><w:r><w:t>private-canary</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`;
    const path = await docxFile(document);

    try {
      await readDocxArtifact(path);
      throw new Error('Expected namespace inventory rejection.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'unknown_feature' } });
      expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details })).not.toContain('private-canary');
    }
  });

  it.each([
    ['stylesheet processing instruction', '<?xml-stylesheet href="https://private-canary.invalid/style.xsl"?>'],
    ['declaration-prefix processing instruction', '<?xml private-canary?>']
  ])('rejects a %s without retaining or reporting its payload', async (_name, instruction) => {
    const document = documentXml('<w:p><w:r><w:t>safe</w:t></w:r></w:p>').replace(
      '<?xml version="1.0" encoding="UTF-8"?>',
      instruction
    );
    const path = await docxFile(document);
    try {
      await readDocxArtifact(path);
      throw new Error('Expected processing-instruction rejection.');
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'unknown_feature' } });
      expect(JSON.stringify({ message: (error as Error).message, details: (error as { details?: unknown }).details })).not.toContain('private-canary');
    }
  });

  it('enforces paragraph and text-node limits across all supported text parts', async () => {
    const paragraphs = (prefix: string, count: number) => Array.from({ length: count }, (_, index) =>
      `<w:p><w:r><w:t>${prefix}${String(index).padStart(5, '0')}</w:t></w:r></w:p>`).join('');
    const header: SupportedTextPart = {
      id: 'rId2',
      kind: 'header',
      name: 'header1.xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><w:hdr xmlns:w="${wordNamespace}">${paragraphs('h', 25_000)}</w:hdr>`
    };
    const document = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}" xmlns:r="${officeRelationshipNamespace}"><w:body>${paragraphs('d', 25_001)}<w:sectPr><w:headerReference r:id="rId2" w:type="default"/></w:sectPr></w:body></w:document>`;
    const path = await writeSyntheticDocx(supportedPackageParts(document, [header]));

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
