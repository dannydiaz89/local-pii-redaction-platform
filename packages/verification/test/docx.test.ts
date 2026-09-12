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

const commentsContentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

function commentedPackage(bodyValue: string, commentValue: string, author: string): Buffer {
  return zip([
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/><Override PartName="/word/comments.xml" ContentType="${commentsContentType}"/></Types>`
    },
    {
      name: '_rels/.rels',
      contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
    },
    {
      name: 'word/document.xml',
      contents: `<?xml version="1.0"?><w:document xmlns:w="${wordNamespace}"><w:body><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>${bodyValue}</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p><w:sectPr/></w:body></w:document>`
    },
    {
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId2" Type="${officeRelationshipPrefix}comments" Target="comments.xml"/></Relationships>`
    },
    {
      name: 'word/comments.xml',
      contents: `<?xml version="1.0"?><w:comments xmlns:w="${wordNamespace}"><w:comment w:id="1" w:author="${author}"><w:p><w:r><w:t>${commentValue}</w:t></w:r></w:p></w:comment></w:comments>`
    }
  ]);
}

function commentedSource(bodyValue: string, commentValue: string, author: string): {
  readonly text: string;
  readonly regions: readonly CanonicalRegion[];
  readonly commentStart: number;
  readonly authorStart: number;
} {
  const paragraphBoundary = '\n\u0000\n';
  const commentStart = unicodeCodePointLength(bodyValue) + unicodeCodePointLength(paragraphBoundary);
  const authorStart = commentStart + unicodeCodePointLength(commentValue) + unicodeCodePointLength(carrierBoundary);
  return {
    text: `${bodyValue}${paragraphBoundary}${commentValue}${carrierBoundary}${author}`,
    regions: [
      {
        schemaVersion: '2.0.0', start: 0, end: unicodeCodePointLength(bodyValue),
        offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
        location: { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/document.xml', paragraph: 1 }
      },
      {
        schemaVersion: '2.0.0', start: commentStart, end: commentStart + unicodeCodePointLength(commentValue),
        offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
        location: { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: 'word/comments.xml', paragraph: 1 }
      },
      {
        schemaVersion: '2.0.0', start: authorStart, end: authorStart + unicodeCodePointLength(author),
        offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
        location: {
          schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part: 'word/comments.xml',
          element: 'w:comment', elementOrdinal: 1, carrier: 'ATTRIBUTE', attribute: 'w:author'
        }
      }
    ],
    commentStart,
    authorStart
  };
}

const commentCompanionContentTypes = {
  commentsExtended: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
  commentsIds: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml',
  commentsExtensible: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml',
  people: 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml'
} as const;
const commentCompanionRelationshipTypes = {
  commentsExtended: 'http://schemas.microsoft.com/office/2011/relationships/commentsExtended',
  commentsIds: 'http://schemas.microsoft.com/office/2016/09/relationships/commentsIds',
  commentsExtensible: 'http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible',
  people: 'http://schemas.microsoft.com/office/2011/relationships/people'
} as const;
const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const w14Namespace = 'http://schemas.microsoft.com/office/word/2010/wordml';
const w15Namespace = 'http://schemas.microsoft.com/office/word/2012/wordml';
const w16Namespace = 'http://schemas.microsoft.com/office/word/2018/wordml';
const w16cexNamespace = 'http://schemas.microsoft.com/office/word/2018/wordml/cex';
const w16cidNamespace = 'http://schemas.microsoft.com/office/word/2016/wordml/cid';
const markupNamespaces = `xmlns:mc="${markupCompatibilityNamespace}" xmlns:w="${wordNamespace}" xmlns:w14="${w14Namespace}"`;

/**
 * The same Word-authored shape the adapter fixture builds: two threaded
 * comments plus the three companion parts. It is reconstructed here from the
 * package bytes alone, so a companion surface only the adapter can see fails a
 * test instead of passing silently.
 */
interface CommentCompanionValues {
  readonly commentValue: string;
  readonly author: string;
  readonly firstDate: string;
  readonly secondDate: string;
  readonly firstDateUtc: string;
  readonly secondDateUtc: string;
  readonly personAuthor: string;
  readonly providerId: string;
  readonly userId: string;
}

const wordAuthoredCompanionValues: CommentCompanionValues = {
  commentValue: 'comment-canary alpha@example.test',
  author: 'Dana Reviewer',
  firstDate: '2026-01-02T03:04:05Z',
  secondDate: '2026-01-02T04:05:06Z',
  firstDateUtc: '2026-01-02T03:04:05.74Z',
  secondDateUtc: '2026-01-02T04:05:06.161Z',
  personAuthor: 'Dana Reviewer',
  providerId: 'AD',
  userId: 'S-1-5-21-1004336348-1177238915-682003330-1417'
};

function companionValues(overrides: Partial<CommentCompanionValues> = {}): CommentCompanionValues {
  return { ...wordAuthoredCompanionValues, ...overrides };
}

function commentCompanionPackage(values: CommentCompanionValues): Buffer {
  const { commentValue, author, firstDate, secondDate, firstDateUtc, secondDateUtc, personAuthor, providerId, userId } = values;
  const overrides = [
    `<Override PartName="/word/comments.xml" ContentType="${commentsContentType}"/>`,
    ...Object.entries(commentCompanionContentTypes).map(([part, type]) => `<Override PartName="/word/${part}.xml" ContentType="${type}"/>`)
  ].join('');
  const relationships = [
    `<Relationship Id="rId2" Type="${officeRelationshipPrefix}comments" Target="comments.xml"/>`,
    ...Object.entries(commentCompanionRelationshipTypes).map(([part, type], index) => `<Relationship Id="rId${String(index + 3)}" Type="${type}" Target="${part}.xml"/>`)
  ].join('');
  const comment = (id: string, paragraphId: string, commentAuthor: string, initials: string, date: string, text: string): string =>
    `<w:comment w:id="${id}" w:author="${commentAuthor}" w:date="${date}" w:initials="${initials}">`
    + `<w:p w14:paraId="${paragraphId}" w14:textId="9C0D1E2F" w:rsidR="00AA00BB" w:rsidRDefault="00AA00BB">`
    + '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>'
    + `<w:r><w:t>${text}</w:t></w:r></w:p></w:comment>`;
  return zip([
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${mediaType}"/>${overrides}</Types>`
    },
    {
      name: '_rels/.rels',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/></Relationships>`
    },
    {
      name: 'word/document.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${markupNamespaces} xmlns:w15="${w15Namespace}" mc:Ignorable="w14 w15"><w:body>`
        + '<w:p w14:paraId="1A2B3C4D" w14:textId="5E6F7A8B" w:rsidR="00AA00BB" w:rsidRDefault="00AA00BB">'
        + '<w:commentRangeStart w:id="1"/><w:commentRangeStart w:id="2"/><w:r><w:t>body-canary</w:t></w:r>'
        + '<w:commentRangeEnd w:id="1"/><w:commentRangeEnd w:id="2"/>'
        + '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r>'
        + '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="2"/></w:r></w:p>'
        + '<w:sectPr w:rsidR="00AA00BB"/></w:body></w:document>'
    },
    {
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${packageRelationshipNamespace}">${relationships}</Relationships>`
    },
    {
      name: 'word/comments.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${markupNamespaces} mc:Ignorable="w14">`
        + comment('1', '7E5CADBD', author, 'DR', firstDate, commentValue)
        + comment('2', '7D0E2935', 'Robin Author', 'RA', secondDate, 'reply-canary')
        + '</w:comments>'
    },
    {
      name: 'word/commentsExtended.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:mc="${markupCompatibilityNamespace}" xmlns:w15="${w15Namespace}" mc:Ignorable="w15">`
        + '<w15:commentEx w15:paraId="7E5CADBD" w15:done="0"/><w15:commentEx w15:paraId="7D0E2935" w15:paraIdParent="7E5CADBD" w15:done="0"/>'
        + '</w15:commentsEx>'
    },
    {
      name: 'word/commentsIds.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w16cid:commentsIds xmlns:mc="${markupCompatibilityNamespace}" xmlns:w16cid="${w16cidNamespace}" mc:Ignorable="w16cid">`
        + '<w16cid:commentId w16cid:paraId="7E5CADBD" w16cid:durableId="552C72BB"/><w16cid:commentId w16cid:paraId="7D0E2935" w16cid:durableId="22DFF939"/>'
        + '</w16cid:commentsIds>'
    },
    {
      name: 'word/commentsExtensible.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w16cex:commentsExtensible xmlns:mc="${markupCompatibilityNamespace}" xmlns:w16="${w16Namespace}" xmlns:w16cex="${w16cexNamespace}" mc:Ignorable="w16 w16cex">`
        + `<w16cex:commentExtensible w16cex:durableId="552C72BB" w16cex:dateUtc="${firstDateUtc}"/>`
        + `<w16cex:commentExtensible w16cex:durableId="22DFF939" w16cex:dateUtc="${secondDateUtc}"/>`
        + '</w16cex:commentsExtensible>'
    },
    {
      name: 'word/people.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:mc="${markupCompatibilityNamespace}" xmlns:w15="${w15Namespace}" mc:Ignorable="w15">`
        + `<w15:person w15:author="${personAuthor}"><w15:presenceInfo w15:providerId="${providerId}" w15:userId="${userId}"/></w15:person>`
        + '<w15:person w15:author="Robin Author"><w15:presenceInfo w15:providerId="None" w15:userId="Robin Author"/></w15:person>'
        + '</w15:people>'
    }
  ]);
}

function xmlValueLocation(part: string, element: string, elementOrdinal: number, attribute: string): Extract<CanonicalRegion['location'], { readonly kind: 'DOCX_XML_VALUE' }> {
  return { schemaVersion: '2.0.0', kind: 'DOCX_XML_VALUE', part, element, elementOrdinal, carrier: 'ATTRIBUTE', attribute };
}

function commentCompanionSource(values: CommentCompanionValues, omit: 'companion' | 'people' | 'none' = 'none'): {
  readonly text: string;
  readonly regions: readonly CanonicalRegion[];
  readonly offsetOf: (value: string) => number;
} {
  const { commentValue, author, firstDate, secondDate, firstDateUtc, secondDateUtc, personAuthor, providerId, userId } = values;
  const paragraphBoundary = '\n\u0000\n';
  const paragraphs = [
    { part: 'word/document.xml', paragraph: 1, value: 'body-canary' },
    { part: 'word/comments.xml', paragraph: 1, value: commentValue },
    { part: 'word/comments.xml', paragraph: 2, value: 'reply-canary' }
  ];
  const carriers = [
    { value: author, location: xmlValueLocation('word/comments.xml', 'w:comment', 1, 'w:author') },
    { value: firstDate, location: xmlValueLocation('word/comments.xml', 'w:comment', 1, 'w:date') },
    { value: 'DR', location: xmlValueLocation('word/comments.xml', 'w:comment', 1, 'w:initials') },
    { value: 'Robin Author', location: xmlValueLocation('word/comments.xml', 'w:comment', 2, 'w:author') },
    { value: secondDate, location: xmlValueLocation('word/comments.xml', 'w:comment', 2, 'w:date') },
    { value: 'RA', location: xmlValueLocation('word/comments.xml', 'w:comment', 2, 'w:initials') },
    { value: 'CommentReference', location: xmlValueLocation('word/comments.xml', 'w:rStyle', 1, 'w:val') },
    { value: 'CommentReference', location: xmlValueLocation('word/comments.xml', 'w:rStyle', 2, 'w:val') },
    ...(omit === 'companion' ? [] : [
      { value: firstDateUtc, location: xmlValueLocation('word/commentsExtensible.xml', 'w16cex:commentExtensible', 1, 'w16cex:dateUtc') },
      { value: secondDateUtc, location: xmlValueLocation('word/commentsExtensible.xml', 'w16cex:commentExtensible', 2, 'w16cex:dateUtc') }
    ]),
    { value: 'CommentReference', location: xmlValueLocation('word/document.xml', 'w:rStyle', 1, 'w:val') },
    { value: 'CommentReference', location: xmlValueLocation('word/document.xml', 'w:rStyle', 2, 'w:val') },
    // Every attribute `word/people.xml` carries is identity, so the independent
    // classification expects all six of them in the source map.
    ...(omit === 'people' ? [] : [
      { value: personAuthor, location: xmlValueLocation('word/people.xml', 'w15:person', 1, 'w15:author') },
      { value: 'Robin Author', location: xmlValueLocation('word/people.xml', 'w15:person', 2, 'w15:author') },
      { value: providerId, location: xmlValueLocation('word/people.xml', 'w15:presenceInfo', 1, 'w15:providerId') },
      { value: userId, location: xmlValueLocation('word/people.xml', 'w15:presenceInfo', 1, 'w15:userId') },
      { value: 'None', location: xmlValueLocation('word/people.xml', 'w15:presenceInfo', 2, 'w15:providerId') },
      { value: 'Robin Author', location: xmlValueLocation('word/people.xml', 'w15:presenceInfo', 2, 'w15:userId') }
    ])
  ];
  const pieces: string[] = [];
  const regions: CanonicalRegion[] = [];
  let cursor = 0;
  for (const paragraph of paragraphs) {
    if (pieces.length > 0) {
      pieces.push(paragraphBoundary);
      cursor += unicodeCodePointLength(paragraphBoundary);
    }
    pieces.push(paragraph.value);
    regions.push({
      schemaVersion: '2.0.0', start: cursor, end: cursor + unicodeCodePointLength(paragraph.value),
      offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
      location: { schemaVersion: '1.0.0', kind: 'DOCX_PART', part: paragraph.part, paragraph: paragraph.paragraph }
    });
    cursor += unicodeCodePointLength(paragraph.value);
  }
  for (const carrier of carriers) {
    pieces.push(carrierBoundary, carrier.value);
    cursor += unicodeCodePointLength(carrierBoundary);
    regions.push({
      schemaVersion: '2.0.0', start: cursor, end: cursor + unicodeCodePointLength(carrier.value),
      offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE', location: carrier.location
    });
    cursor += unicodeCodePointLength(carrier.value);
  }
  const text = pieces.join('');
  return {
    text,
    regions,
    offsetOf: (value: string): number => {
      const offset = text.indexOf(value);
      if (offset < 0) throw new Error('Synthetic companion value is absent.');
      return unicodeCodePointLength(text.slice(0, offset));
    }
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

  /**
   * The adapter pins the same digest for the same package shape in
   * `packages/adapter-docx/test/adapter.test.ts`. The verifier recomputes it
   * from the bytes alone and reports EXTRACTION_REVISION_MISMATCH when the two
   * comment surfaces drift, so the pin fails loudly instead of silently leaving
   * one implementation blind to comment text.
   */
  it('agrees with the adapter on the comment extraction revision', () => {
    const classified = commentedSource('safe', 'alpha@example.test', 'Dana Reviewer');

    expect(extractionRevision(classified.text, classified.regions))
      .toBe('sha256:eeb13e3492ebd10a9d17d22393227dac1011804d7ac4d3417303fdb93ccbbc71');
  });

  it('reconciles planned deltas inside a comment paragraph and a comment author attribute', () => {
    const commentValue = 'alpha@example.test';
    const author = 'Dana Reviewer';
    const input = commentedPackage('safe', commentValue, author);
    const output = commentedPackage('safe', '[EMAIL_1]', '[PERSON_1]');
    const classified = commentedSource('safe', commentValue, author);

    expect(verifyIndependentDocxFoundation(requestFor(input, output, classified.text, classified.regions, [
      {
        id: actionId, entityType: 'EMAIL', start: classified.commentStart,
        end: classified.commentStart + unicodeCodePointLength(commentValue), replacement: '[EMAIL_1]'
      },
      {
        id: 'act_00000000000000000000000002', entityType: 'PERSON', start: classified.authorStart,
        end: classified.authorStart + unicodeCodePointLength(author), replacement: '[PERSON_1]'
      }
    ]))).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS', findings: [], retainedRegionCount: 3, classifiedRegionCount: 3
    });
  });

  it('fails an unredacted entity planted in a comment paragraph', () => {
    const commentValue = 'alpha@example.test';
    const input = commentedPackage('safe', commentValue, 'Dana');
    const classified = commentedSource('safe', commentValue, 'Dana');

    expect(verifyIndependentDocxFoundation(requestFor(input, input, classified.text, classified.regions, []))).toMatchObject({
      outcome: 'FAIL', findings: [{ code: 'RESIDUAL_ENTITY', count: 1, entityType: 'EMAIL' }]
    });
  });

  it('refuses to reconcile a comment canary the writer claimed to remove but retained', () => {
    const commentValue = 'canary-9f2c';
    const input = commentedPackage('safe', commentValue, 'Dana');
    const classified = commentedSource('safe', commentValue, 'Dana');

    expect(verifyIndependentDocxFoundation(requestFor(input, input, classified.text, classified.regions, [{
      id: actionId, entityType: 'CUSTOM', start: classified.commentStart,
      end: classified.commentStart + unicodeCodePointLength(commentValue), replacement: '[CUSTOM_1]'
    }]))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'PLANNED_NATIVE_DELTA_MISMATCH', count: 1 }]
    });
  });

  it('refuses a source map that omits the comment part the package actually carries', () => {
    const input = commentedPackage('safe', 'canary-4d81', 'Dana');

    expect(verifyIndependentDocxFoundation(requestFor(input, input, 'safe', [paragraphRegionV2('safe')], []))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'CARRIER_CLASSIFICATION_MISMATCH', count: 1 }]
    });
  });

  /**
   * `packages/adapter-docx/test/adapter.test.ts` pins this digest for the same
   * Word-authored package shape. The verifier recomputes it from the bytes and
   * reports EXTRACTION_REVISION_MISMATCH when the two companion surfaces drift,
   * so a part only one implementation enumerates fails loudly.
   */
  it('agrees with the adapter on the comment companion and author identity extraction revision', () => {
    const classified = commentCompanionSource(companionValues());

    expect(extractionRevision(classified.text, classified.regions))
      .toBe('sha256:e39d87ba9a4804609f619cef08ba20a4939c0105501fb3b528000ed02688852d');
  });

  it('reconciles planned deltas across the comment and companion date carriers', () => {
    // The person list keeps its own author name so that the planned comment
    // author delta is a unique source value rather than one copy of two.
    const values = companionValues({ commentValue: 'safe', personAuthor: 'Ash Listed' });
    const input = commentCompanionPackage(values);
    const output = commentCompanionPackage({
      ...values, author: '[PERSON_1]', firstDate: '[PHONE_1]', secondDate: '[PHONE_2]',
      firstDateUtc: '[PHONE_3]', secondDateUtc: '[PHONE_4]'
    });
    const classified = commentCompanionSource(values);
    const span = (value: string, id: string, entityType: 'PERSON' | 'PHONE', replacement: string) => ({
      id, entityType, start: classified.offsetOf(value),
      end: classified.offsetOf(value) + unicodeCodePointLength(value), replacement
    });

    expect(verifyIndependentDocxFoundation(requestFor(input, output, classified.text, classified.regions, [
      span(values.author, actionId, 'PERSON', '[PERSON_1]'),
      span(values.firstDate, 'act_00000000000000000000000002', 'PHONE', '[PHONE_1]'),
      span(values.secondDate, 'act_00000000000000000000000003', 'PHONE', '[PHONE_2]'),
      span(values.firstDateUtc, 'act_00000000000000000000000004', 'PHONE', '[PHONE_3]'),
      span(values.secondDateUtc, 'act_00000000000000000000000005', 'PHONE', '[PHONE_4]')
    ]))).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS', findings: [], retainedRegionCount: 21, classifiedRegionCount: 21
    });
  });

  /**
   * The author display name and the presence user id are the reason this part
   * is extracted at all, so a plan that redacts them has to reconcile against
   * the reopened package exactly like any other carrier.
   */
  it('reconciles planned deltas across the author name and presence identity carriers', () => {
    const values = companionValues({ commentValue: 'safe', author: 'safe-author', userId: 'dana.reviewer@example.test' });
    const input = commentCompanionPackage(values);
    const output = commentCompanionPackage({ ...values, personAuthor: '[PERSON_1]', userId: '[EMAIL_1]' });
    const classified = commentCompanionSource(values);
    const span = (value: string, id: string, entityType: 'PERSON' | 'EMAIL', replacement: string) => ({
      id, entityType, start: classified.offsetOf(value),
      end: classified.offsetOf(value) + unicodeCodePointLength(value), replacement
    });

    expect(verifyIndependentDocxFoundation(requestFor(input, output, classified.text, classified.regions, [
      span(values.personAuthor, actionId, 'PERSON', '[PERSON_1]'),
      span(values.userId, 'act_00000000000000000000000002', 'EMAIL', '[EMAIL_1]')
    ]))).toMatchObject({
      outcome: 'RECONCILED_SUPPLIED_REGIONS', findings: [], retainedRegionCount: 21, classifiedRegionCount: 21
    });
  });

  it('refuses to reconcile an author identity canary the writer claimed to remove but retained', () => {
    const values = companionValues({ commentValue: 'safe', author: 'safe-author', personAuthor: 'canary-9f4c' });
    const input = commentCompanionPackage(values);
    const classified = commentCompanionSource(values);

    expect(verifyIndependentDocxFoundation(requestFor(input, input, classified.text, classified.regions, [{
      id: actionId, entityType: 'CUSTOM', start: classified.offsetOf('canary-9f4c'),
      end: classified.offsetOf('canary-9f4c') + unicodeCodePointLength('canary-9f4c'), replacement: '[CUSTOM_1]'
    }]))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'PLANNED_NATIVE_DELTA_MISMATCH', count: 1 }]
    });
  });

  it.each([
    ['author display name', { personAuthor: 'alpha@example.test' }],
    ['presence user identifier', { userId: 'alpha@example.test' }]
  ])('fails an unredacted entity planted in the %s carrier', (_name, overrides) => {
    const values = companionValues({ commentValue: 'safe', author: 'safe-author', ...overrides });
    const input = commentCompanionPackage(values);
    const classified = commentCompanionSource(values);

    expect(verifyIndependentDocxFoundation(requestFor(input, input, classified.text, classified.regions, [])))
      .toMatchObject({ outcome: 'FAIL', findings: expect.arrayContaining([{ code: 'RESIDUAL_ENTITY', count: 1, entityType: 'EMAIL' }]) as unknown[] });
  });

  it('refuses a source map that omits the author identity carriers the package actually carries', () => {
    const values = companionValues({ commentValue: 'safe', author: 'safe-author' });
    const input = commentCompanionPackage(values);
    const classified = commentCompanionSource(values, 'people');

    expect(verifyIndependentDocxFoundation(requestFor(input, input, classified.text, classified.regions, []))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'CARRIER_CLASSIFICATION_MISMATCH', count: 1 }]
    });
  });

  it('refuses to reconcile a companion date canary the writer claimed to remove but retained', () => {
    const values = companionValues({ commentValue: 'safe', firstDateUtc: 'canary-3b7e' });
    const input = commentCompanionPackage(values);
    const classified = commentCompanionSource(values);

    expect(verifyIndependentDocxFoundation(requestFor(input, input, classified.text, classified.regions, [{
      id: actionId, entityType: 'CUSTOM', start: classified.offsetOf('canary-3b7e'),
      end: classified.offsetOf('canary-3b7e') + unicodeCodePointLength('canary-3b7e'), replacement: '[CUSTOM_1]'
    }]))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'PLANNED_NATIVE_DELTA_MISMATCH', count: 1 }]
    });
  });

  it('fails an unredacted entity planted in a comment companion date carrier', () => {
    const values = companionValues({ commentValue: 'safe', firstDateUtc: 'alpha@example.test' });
    const input = commentCompanionPackage(values);
    const classified = commentCompanionSource(values);

    expect(verifyIndependentDocxFoundation(requestFor(input, input, classified.text, classified.regions, [])))
      .toMatchObject({ outcome: 'FAIL', findings: expect.arrayContaining([{ code: 'RESIDUAL_ENTITY', count: 1, entityType: 'EMAIL' }]) as unknown[] });
  });

  it('refuses a source map that omits the comment companion carriers the package actually carries', () => {
    const values = companionValues({ commentValue: 'safe' });
    const input = commentCompanionPackage(values);
    const classified = commentCompanionSource(values, 'companion');

    expect(verifyIndependentDocxFoundation(requestFor(input, input, classified.text, classified.regions, []))).toMatchObject({
      outcome: 'INCOMPLETE', findings: [{ code: 'CARRIER_CLASSIFICATION_MISMATCH', count: 1 }]
    });
  });
});
