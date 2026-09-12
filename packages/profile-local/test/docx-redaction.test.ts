import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { computeWriterReceiptDigest } from '@local-pii/contracts';
import {
  createLocalDocxArtifactSession,
  docxWriterDescriptor,
  readDocxArtifact,
  type DocxArtifact
} from '@local-pii/adapter-docx';
import { parseSha256Digest, type CanonicalRegion, type Sha256Digest } from '@local-pii/domain';
import { bundledPolicies, compilePolicy } from '@local-pii/policy';
import { compileTypedLabelPlan, type TypedLabelPlan } from '@local-pii/redaction';
import { verifyBoundDocxRedaction, verifyIndependentDocxFoundation } from '@local-pii/verification';

import { docxCapabilityRequirement, localDocxApplication, localFileApplication } from '../src/application.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const packageRelationshipNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeRelationshipPrefix = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const officeRelationshipNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types';
const markupCompatibilityNamespace = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const docxMediaType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const w14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const w15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
const w16 = 'http://schemas.microsoft.com/office/word/2018/wordml';
const w16cex = 'http://schemas.microsoft.com/office/word/2018/wordml/cex';
const w16cid = 'http://schemas.microsoft.com/office/word/2016/wordml/cid';
const threadParagraphId = '7E5CADBD';

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

function zip(entries: readonly { readonly name: string; readonly contents: string }[]): Buffer {
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

/**
 * Every declared carrier surface this adapter qualified over the DOCX series, each holding a
 * distinct planted value so a residual can be attributed to exactly one of them.
 */
interface PackageValues {
  readonly documentText: string;
  readonly headerText: string;
  readonly deletedText: string;
  readonly commentText: string;
  readonly commentAuthor: string;
  readonly userId: string;
  readonly creator: string;
  /** Replaces the revised paragraph body wholesale, for tracked-revision forgeries. */
  readonly revisedParagraph?: string;
  /** Replaces the first visible run wholesale, for structural forgeries. */
  readonly documentRun?: string;
  /** The anchored paragraph id, which no plan ever targets, for unplanned-delta forgeries. */
  readonly paragraphId?: string;
}

const plantedValues: PackageValues = {
  documentText: 'Call visible@example.test now',
  headerText: 'Prepared by header@example.test',
  deletedText: 'deleted@example.test',
  commentText: 'ping comment@example.test',
  commentAuthor: 'author@example.test',
  userId: 'user@example.test',
  creator: 'creator@example.test'
};

/** The typed labels the deterministic rules assign to the planted values, in canonical order. */
const labels = {
  documentText: 'Call [EMAIL_1] now',
  deletedText: '[EMAIL_2]',
  headerText: 'Prepared by [EMAIL_3]',
  commentText: 'ping [EMAIL_4]',
  creator: '[EMAIL_5]',
  commentAuthor: '[EMAIL_6]',
  userId: '[EMAIL_7]'
} as const;

function wordPackage(overrides: Partial<PackageValues> = {}): readonly { readonly name: string; readonly contents: string }[] {
  const values = { ...plantedValues, ...overrides };
  const documentRun = values.documentRun ?? `<w:r><w:t>${values.documentText}</w:t></w:r>`;
  const anchored = `<w:p w14:paraId="${values.paragraphId ?? '1A2B3C4D'}" w14:textId="5E6F7A8B" w:rsidR="00AA00BB" w:rsidRDefault="00AA00BB">`
    + `<w:commentRangeStart w:id="1"/>${documentRun}<w:commentRangeEnd w:id="1"/>`
    + '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="1"/></w:r></w:p>';
  const revised = values.revisedParagraph
    ?? '<w:p w14:paraId="2B3C4D5E" w14:textId="6F7A8B9C" w:rsidR="00AA00BB" w:rsidRDefault="00AA00BB">'
      + '<w:r><w:t xml:space="preserve">holder </w:t></w:r>'
      + `<w:del w:id="10" w:author="Dana Reviewer" w:date="2026-01-02T05:06:07Z"><w:r><w:delText>${values.deletedText}</w:delText></w:r></w:del>`
      + '<w:ins w:id="11" w:author="Robin Author" w:date="2026-01-02T06:07:08Z"><w:r><w:t>kept</w:t></w:r></w:ins></w:p>';
  const sectionProperties = '<w:sectPr w:rsidR="00AA00BB"><w:headerReference r:id="rId7" w:type="default"/>'
    + '<w:pgSz w:w="12240" w:h="15840"/>'
    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
    + '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';
  const overridesXml = [
    ['/word/document.xml', docxMediaType],
    ['/word/header1.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'],
    ['/word/comments.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml'],
    ['/word/commentsExtended.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml'],
    ['/word/commentsIds.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsIds+xml'],
    ['/word/commentsExtensible.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtensible+xml'],
    ['/word/people.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.people+xml'],
    ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml']
  ].map(([part, type]) => `<Override PartName="${part ?? ''}" ContentType="${type ?? ''}"/>`).join('');
  const documentRelationships = [
    `<Relationship Id="rId2" Type="${officeRelationshipPrefix}comments" Target="comments.xml"/>`,
    '<Relationship Id="rId3" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>',
    '<Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2016/09/relationships/commentsIds" Target="commentsIds.xml"/>',
    '<Relationship Id="rId5" Type="http://schemas.microsoft.com/office/2018/08/relationships/commentsExtensible" Target="commentsExtensible.xml"/>',
    '<Relationship Id="rId6" Type="http://schemas.microsoft.com/office/2011/relationships/people" Target="people.xml"/>',
    `<Relationship Id="rId7" Type="${officeRelationshipPrefix}header" Target="header1.xml"/>`
  ].join('');
  const markup = `xmlns:mc="${markupCompatibilityNamespace}" xmlns:w="${wordNamespace}" xmlns:w14="${w14}"`;
  return [
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${contentTypesNamespace}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overridesXml}</Types>`
    },
    {
      name: '_rels/.rels',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${packageRelationshipNamespace}"><Relationship Id="rId1" Type="${officeRelationshipPrefix}officeDocument" Target="word/document.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`
    },
    {
      name: 'word/document.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${markup} xmlns:r="${officeRelationshipNamespace}" xmlns:w15="${w15}" mc:Ignorable="w14 w15"><w:body>${anchored}${revised}${sectionProperties}</w:body></w:document>`
    },
    {
      name: 'word/_rels/document.xml.rels',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${packageRelationshipNamespace}">${documentRelationships}</Relationships>`
    },
    {
      name: 'word/header1.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${markup} mc:Ignorable="w14"><w:p><w:r><w:t>${values.headerText}</w:t></w:r></w:p></w:hdr>`
    },
    {
      name: 'word/comments.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${markup} mc:Ignorable="w14">`
        + `<w:comment w:id="1" w:author="${values.commentAuthor}" w:date="2026-01-02T03:04:05Z" w:initials="DR">`
        + `<w:p w14:paraId="${threadParagraphId}" w14:textId="9C0D1E2F" w:rsidR="00AA00BB" w:rsidRDefault="00AA00BB">`
        + '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>'
        + `<w:r><w:t>${values.commentText}</w:t></w:r></w:p></w:comment></w:comments>`
    },
    {
      name: 'word/commentsExtended.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:mc="${markupCompatibilityNamespace}" xmlns:w15="${w15}" mc:Ignorable="w15"><w15:commentEx w15:paraId="${threadParagraphId}" w15:done="0"/></w15:commentsEx>`
    },
    {
      name: 'word/commentsIds.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w16cid:commentsIds xmlns:mc="${markupCompatibilityNamespace}" xmlns:w16cid="${w16cid}" mc:Ignorable="w16cid"><w16cid:commentId w16cid:paraId="${threadParagraphId}" w16cid:durableId="552C72BB"/></w16cid:commentsIds>`
    },
    {
      name: 'word/commentsExtensible.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w16cex:commentsExtensible xmlns:mc="${markupCompatibilityNamespace}" xmlns:w16="${w16}" xmlns:w16cex="${w16cex}" mc:Ignorable="w16 w16cex"><w16cex:commentExtensible w16cex:durableId="552C72BB" w16cex:dateUtc="2026-01-02T03:04:05.74Z"/></w16cex:commentsExtensible>`
    },
    {
      name: 'word/people.xml',
      contents: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:people xmlns:mc="${markupCompatibilityNamespace}" xmlns:w15="${w15}" mc:Ignorable="w15"><w15:person w15:author="Dana Reviewer"><w15:presenceInfo w15:providerId="AD" w15:userId="${values.userId}"/></w15:person></w15:people>`
    },
    {
      name: 'docProps/core.xml',
      contents: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        + `<dc:creator>${values.creator}</dc:creator></cp:coreProperties>`
    }
  ];
}

async function workspace(overrides: Partial<PackageValues> = {}): Promise<{ readonly root: string; readonly input: string; readonly output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-redact-'));
  roots.push(root);
  const input = join(root, 'document.docx');
  await writeFile(input, zip(wordPackage(overrides)));
  return { root, input, output: join(root, 'document.redacted.docx') };
}

const policy = compilePolicy(bundledPolicies['development-labels']);
const capabilityDigest = parseSha256Digest(`sha256:${'2'.repeat(64)}`);
const application = { id: 'local-pii-cli', version: '0.1.0', digest: parseSha256Digest(`sha256:${'f'.repeat(64)}`) };

function digestOf(bytes: Uint8Array): Sha256Digest {
  return parseSha256Digest(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
}

/**
 * Compiles a plan over every detection the real scan resolves, minus the omitted canonical
 * values. Omitting one models a plan that never covered a carrier rather than a writer that
 * failed to apply it, which is the leak shape the verifier has to catch on its own.
 */
type OmitSpan = (value: string, location: CanonicalRegion['location']) => boolean;

async function planFor(source: DocxArtifact, omit: OmitSpan = () => false): Promise<TypedLabelPlan> {
  const scanned = await localDocxApplication.scan({
    session: { input: () => Promise.resolve(source) },
    requirement: docxCapabilityRequirement('SCAN')
  }, { correlationId: 'cor_docx_redaction_test' });
  expect(scanned.resolution.conflicts).toHaveLength(0);
  return compileTypedLabelPlan({
    ...scanned.resolution,
    spans: scanned.resolution.spans.filter((span) => {
      const region = source.regions.find(({ start, end }) => span.start >= start && span.end <= end);
      if (region === undefined) throw new Error('Every planted span must fall inside one source region.');
      return !omit(source.text.slice(span.start, span.end), region.location);
    })
  }, {
    inputDigest: source.digest,
    capabilityDigest,
    detectorBundleVersion: scanned.detectorBundleVersion,
    policy: { id: policy.id, version: policy.version, digest: policy.digest, riskTier: policy.riskTier },
    writer: docxWriterDescriptor
  });
}

function planBinding(plan: TypedLabelPlan) {
  return {
    id: plan.id,
    digest: plan.digest,
    inputDigest: plan.inputDigest,
    extractionRevision: plan.extractionRevision,
    capabilityDigest: plan.capabilityDigest,
    policy: plan.policy,
    writer: plan.writer,
    expectedActionCount: plan.expectedActionCount,
    actions: plan.actions.map(({ id, sourceSpanId, entityType, start, end, replacement }) => ({
      id, sourceSpanId, entityType, start, end, replacement
    }))
  };
}

function receiptFor(plan: TypedLabelPlan, stagedDigest: Sha256Digest, stagedByteLength: number, appliedActionIds?: readonly string[]) {
  const applied = appliedActionIds ?? plan.actions.map(({ id }) => id);
  const unsigned = {
    schemaVersion: '1.0.0' as const,
    planDigest: plan.digest,
    writer: { id: plan.writer.id, version: plan.writer.version },
    stagedDigest,
    stagedByteLength,
    expectedActionCount: plan.expectedActionCount,
    appliedActionCount: applied.length,
    appliedActionIds: [...applied]
  };
  return { ...unsigned, receiptDigest: parseSha256Digest(computeWriterReceiptDigest(unsigned)) };
}

interface AttestOptions {
  readonly outputBytes?: Buffer;
  readonly reopenedText?: string;
  readonly appliedActionIds?: readonly string[];
  readonly omitBytes?: true;
  readonly omitRegions?: true;
}

/**
 * Assembles the bound request the application hands the profile. Overriding the output bytes
 * models a writer that produced something other than the plan, which is the only interesting
 * failure mode: the profile has to reject it on its own reading of the package.
 */
async function attest(
  source: DocxArtifact,
  inputBytes: Buffer,
  stagedPath: string,
  plan: TypedLabelPlan,
  options: AttestOptions = {}
) {
  const outputBytes = options.outputBytes ?? await readFile(stagedPath);
  const reopenedArtifact = await readDocxArtifact(await candidateFile(stagedPath, outputBytes));
  const reopened = options.reopenedText ?? reopenedArtifact.text;
  const digest = digestOf(outputBytes);
  return verifyBoundDocxRedaction({
    ...(options.omitBytes === true ? {} : { inputBytes, outputBytes }),
    sourceText: source.text,
    ...(options.omitRegions === true ? {} : { sourceRegions: source.regions }),
    reopenedText: reopened,
    input: { digest: source.digest, byteLength: source.byteLength },
    output: {
      digest,
      byteLength: outputBytes.length,
      mediaType: docxMediaType,
      extractionRevision: reopenedArtifact.extractionRevision
    },
    capabilityDigest,
    plan: planBinding(plan),
    policy: { id: policy.id, version: policy.version, digest: policy.digest, riskTier: policy.riskTier },
    writerReceipt: receiptFor(plan, digest, outputBytes.length, options.appliedActionIds),
    writer: docxWriterDescriptor,
    application,
    startedAt: '2026-09-11T00:00:00Z',
    completedAt: '2026-09-11T00:00:01Z'
  });
}

/** Writes candidate output bytes beside the stage so they can be reopened by the real reader. */
async function candidateFile(stagedPath: string, bytes: Buffer): Promise<string> {
  const candidate = `${stagedPath}.candidate.docx`;
  await writeFile(candidate, bytes);
  return candidate;
}

/** The independent reconciliation the profile drives, asserted on its own terms. */
function foundationFor(source: DocxArtifact, inputBytes: Buffer, outputBytes: Buffer, plan: TypedLabelPlan) {
  return verifyIndependentDocxFoundation({
    inputBytes,
    outputBytes,
    sourceCanonicalText: source.text,
    sourceRegions: source.regions,
    plan: planBinding(plan),
    writerReceipt: receiptFor(plan, digestOf(outputBytes), outputBytes.length),
    applicationBinding: {
      capabilityDigest,
      policy: { id: policy.id, version: policy.version, digest: policy.digest, riskTier: policy.riskTier },
      writer: docxWriterDescriptor,
      application,
      outputMediaType: docxMediaType,
      startedAt: '2026-09-11T00:00:00Z',
      completedAt: '2026-09-11T00:00:01Z'
    }
  });
}

async function stagedRedaction(overrides: Partial<PackageValues> = {}, omit: OmitSpan = () => false) {
  const { root, input, output } = await workspace(overrides);
  const session = createLocalDocxArtifactSession(input, output);
  const source = await session.input();
  const plan = await planFor(source, omit);
  const staged = await session.stage(plan);
  return { root, input, output, session, source, plan, staged, inputBytes: await readFile(input) };
}

describe('DOCX redaction under the docx-redact-v1 profile', () => {
  it('requires the redaction profile and the typed-label transformation only for REDACT', () => {
    expect(docxCapabilityRequirement('REDACT')).toMatchObject({
      formatId: 'docx',
      operation: 'REDACT',
      transformationActions: ['TYPED_LABEL'],
      verificationProfile: 'docx-redact-v1'
    });
    expect(docxCapabilityRequirement('SCAN')).toMatchObject({
      transformationActions: [],
      verificationProfile: 'docx-extract-v1'
    });
  });

  it('publishes a verified redaction of a Word-authored package and leaves no planted value in the bytes', async () => {
    const { input, output, root } = await workspace();

    const result = await localDocxApplication.redact({
      session: createLocalDocxArtifactSession(input, output),
      requirement: docxCapabilityRequirement('REDACT'),
      policy
    }, { correlationId: 'cor_docx_redaction_test' });

    expect(result.verification.outcome).toBe('PASS');
    expect(result.verification.profile.id).toBe('docx-redact-v1');
    expect(result.verification.checks).toEqual(['STRUCTURE', 'NATIVE_SURFACE', 'DETERMINISTIC_RESCAN', 'ACTION_RECONCILIATION']);
    expect(result.verification.findings).toEqual([]);
    expect(result.published.reference).toBe(output);

    const published = await readFile(output);
    const planted = [
      plantedValues.documentText, plantedValues.headerText, plantedValues.deletedText,
      plantedValues.commentText, plantedValues.commentAuthor, plantedValues.userId, plantedValues.creator
    ];
    for (const value of planted) expect(published.includes(Buffer.from(value, 'utf8')), value).toBe(false);
    const reopened = await readDocxArtifact(output);
    expect(reopened.text).toContain(labels.documentText);
    expect(reopened.text).toContain(labels.deletedText);
    expect(reopened.text).toContain(labels.headerText);
    expect(reopened.text).toContain(labels.commentText);
    expect(reopened.text).toContain(labels.creator);
    expect(reopened.text).toContain(labels.commentAuthor);
    expect(reopened.text).toContain(labels.userId);
    expect(await readdir(root)).toEqual(['document.docx', 'document.redacted.docx']);
  });

  it('attests PASS for the honest writer over every qualified carrier class', async () => {
    const { source, plan, staged, inputBytes } = await stagedRedaction();

    const report = await attest(source, inputBytes, staged.path, plan);

    expect(report.outcome).toBe('PASS');
    expect(report.findings).toEqual([]);
    expect(report.reconciliation).toMatchObject({ expectedActionCount: 7, appliedActionCount: 7, missingActionCount: 0 });
  });

  // One planted value per declared carrier surface. Omitting exactly that span from the plan is
  // the leak the series has been building towards: the visible text is clean and the value is
  // still in the package, in a comment, in deleted text, in an author attribute or in metadata.
  it.each([
    ['visible document text', 'visible@example.test'],
    ['header text', 'header@example.test'],
    ['deleted text', 'deleted@example.test'],
    ['comment body text', 'comment@example.test'],
    ['comment author identity', 'author@example.test'],
    ['presence user identity', 'user@example.test'],
    ['document property creator', 'creator@example.test']
  ])('fails with a residual entity when the %s canary survives the plan', async (_name, canary) => {
    const { source, plan, staged, inputBytes } = await stagedRedaction({}, (value) => value === canary);
    expect(plan.actions).toHaveLength(6);

    const report = await attest(source, inputBytes, staged.path, plan);

    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({
      code: 'RESIDUAL_ENTITY', entityType: 'EMAIL', blocking: true
    }));
    expect(JSON.stringify(report)).not.toContain(canary);
  });

  it('fails with a metadata residual when a value the plan removed survives in docProps', async () => {
    const shared = 'shared@example.test';
    const values = { documentText: `Call ${shared} now`, creator: shared };
    // The plan removes the visible occurrence and leaves the identical one in `dc:creator`,
    // which is exactly the metadata residue a reader of the redacted document never sees.
    const leaked = await stagedRedaction(
      values,
      (value, location) => value === shared && location.kind === 'DOCX_XML_VALUE'
    );

    const report = await attest(leaked.source, leaked.inputBytes, leaked.staged.path, leaked.plan);

    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'METADATA_RESIDUAL', check: 'STRUCTURE' }));
    expect(JSON.stringify(report)).not.toContain(shared);

    const foundation = foundationFor(leaked.source, leaked.inputBytes, await readFile(leaked.staged.path), leaked.plan);
    expect(foundation.outcome).toBe('FAIL');
    expect(foundation.findings).toContainEqual(expect.objectContaining({ code: 'RESIDUAL_METADATA' }));
  });

  it('fails when the same value survives in deleted text after the visible occurrence is removed', async () => {
    const shared = 'both@example.test';
    // One value, two streams: the text a reader sees and the text Word hid behind a tracked
    // deletion. A plan that covers only the shown stream leaves the package carrying the value.
    const leaked = await stagedRedaction(
      { documentText: `Call ${shared} now`, deletedText: shared },
      (value, location) => value === shared && location.kind === 'DOCX_PART' && location.paragraph === 2
    );

    const report = await attest(leaked.source, leaked.inputBytes, leaked.staged.path, leaked.plan);

    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'RESIDUAL_ENTITY', entityType: 'EMAIL' }));
    expect(JSON.stringify(report)).not.toContain(shared);
  });

  // Exactly the catastrophic writer this series taught us to look for: the label is written and
  // the original address stays in the package as deleted text. The second shape adds no
  // insertion at all, so only the deletion elements move and nothing else can raise the alarm.
  it.each([
    ['as a tracked insertion', `<w:ins w:id="21" w:author="Dana Reviewer" w:date="2026-01-02T05:06:07Z"><w:r><w:t>${labels.documentText}</w:t></w:r></w:ins>`],
    ['as a plain run beside the deletion', `<w:r><w:t>${labels.documentText}</w:t></w:r>`]
  ])('refuses a writer that rewrites a replacement %s and retains the original', async (_name, replacement) => {
    const { source, plan, staged, inputBytes } = await stagedRedaction();
    const forged = zip(wordPackage({
      documentRun: '<w:del w:id="20" w:author="Dana Reviewer" w:date="2026-01-02T05:06:07Z">'
        + `<w:r><w:delText>${plantedValues.documentText}</w:delText></w:r></w:del>${replacement}`,
      deletedText: labels.deletedText,
      headerText: labels.headerText,
      commentText: labels.commentText,
      commentAuthor: labels.commentAuthor,
      userId: labels.userId,
      creator: labels.creator
    }));

    const report = await attest(source, inputBytes, staged.path, plan, { outputBytes: forged });

    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'HIDDEN_TEXT_PRESENT', check: 'STRUCTURE' }));
    expect(JSON.stringify(report)).not.toContain(plantedValues.documentText);

    const foundation = foundationFor(source, inputBytes, forged, plan);
    expect(foundation.outcome).toBe('FAIL');
    expect(foundation.findings).toEqual([{ code: 'TRACKED_REVISION_DELTA', count: 1 }]);
  });

  it('refuses an adapter whose reopened reading of its own output disagrees with the plan', async () => {
    const { source, plan, staged, inputBytes } = await stagedRedaction();

    // The bytes are the honest stage; only the canonical reading handed to the profile is wrong.
    // A writer and a reader that disagree about what the output says have verified nothing.
    const report = await attest(source, inputBytes, staged.path, plan, { reopenedText: source.text });

    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toEqual([expect.objectContaining({ code: 'STRUCTURE_INVALID', check: 'STRUCTURE' })]);
  });

  it('refuses a writer that silently skipped a planned carrier', async () => {
    const { source, plan, staged, inputBytes } = await stagedRedaction();
    const forged = zip(wordPackage({
      documentText: labels.documentText,
      deletedText: labels.deletedText,
      headerText: labels.headerText,
      commentText: labels.commentText,
      commentAuthor: labels.commentAuthor,
      // The presence identity is left exactly as the input carried it.
      userId: plantedValues.userId,
      creator: labels.creator
    }));

    const report = await attest(source, inputBytes, staged.path, plan, { outputBytes: forged });

    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'ACTION_NOT_APPLIED' }));
  });

  it.each([
    ['a missing applied action', (ids: readonly string[]) => ids.slice(1), 'ACTION_NOT_APPLIED'],
    ['a duplicated applied action', (ids: readonly string[]) => [...ids, ids[0] ?? ''], 'DUPLICATE_ACTION'],
    ['an unexpected applied action', (ids: readonly string[]) => [...ids, 'act_0000000000000000000000000Z'], 'UNEXPECTED_ACTION']
  ])('refuses %s in the writer receipt', async (_name, mutate, code) => {
    const { source, plan, staged, inputBytes } = await stagedRedaction();

    const report = await attest(source, inputBytes, staged.path, plan, {
      appliedActionIds: mutate(plan.actions.map(({ id }) => id))
    });

    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({ code, check: 'ACTION_RECONCILIATION' }));
  });

  it('reports INCOMPLETE rather than PASS when the request omits the package bytes or the source map', async () => {
    const { source, plan, staged, inputBytes } = await stagedRedaction();

    for (const options of [{ omitBytes: true } as const, { omitRegions: true } as const]) {
      const report = await attest(source, inputBytes, staged.path, plan, options);
      expect(report.outcome).toBe('INCOMPLETE');
      // The request is refused before any package is parsed, so the check is the structural one
      // rather than a downstream complaint about a source map the profile never accepted.
      expect(report.findings).toEqual([expect.objectContaining({ code: 'VERIFIER_INCOMPLETE', check: 'STRUCTURE' })]);
      // The counts are still the true ones, so the caller reads an undecided verification
      // rather than a writer that appears to have applied nothing.
      expect(report.reconciliation).toEqual({
        expectedActionCount: 7, appliedActionCount: 7, missingActionCount: 0, unexpectedActionCount: 0, duplicateActionCount: 0
      });
    }
  });

  it('refuses a plan that targets a carrier outside the qualified redaction surface', async () => {
    const { root, input, output } = await workspace();
    const session = createLocalDocxArtifactSession(input, output);
    const source = await session.input();
    // `w:comment/@w:date` is a typed OOXML date. Neither the writer nor this verifier validates
    // that lexical space, so a typed label written into it would pass every structural check
    // here and still produce a package Word may refuse. The profile refuses to qualify it.
    const region = source.regions.find(({ location }) =>
      location.kind === 'DOCX_XML_VALUE' && location.attribute === 'w:date' && location.part === 'word/comments.xml');
    if (region === undefined) throw new Error('The synthetic package must carry a comment date carrier.');
    const plan = compileTypedLabelPlan({
      extractionRevision: source.extractionRevision,
      algorithmVersion: '0.3.0',
      digest: parseSha256Digest(`sha256:${'1'.repeat(64)}`),
      spans: [{
        id: `rsp_${'0'.repeat(31)}1`,
        entityType: 'DATE_OF_BIRTH',
        start: region.start,
        end: region.end,
        confidence: 1,
        evidenceIds: ['00000000-0000-5000-8000-000000000001']
      }],
      conflicts: [],
      suppressedEvidenceIds: []
    }, {
      inputDigest: source.digest,
      capabilityDigest,
      detectorBundleVersion: 'docx-redaction-test',
      policy: { id: policy.id, version: policy.version, digest: policy.digest, riskTier: policy.riskTier },
      writer: docxWriterDescriptor
    });
    const staged = await session.stage(plan);

    const report = await attest(source, await readFile(input), staged.path, plan);

    expect(report.outcome).toBe('INCOMPLETE');
    expect(report.findings).toEqual([expect.objectContaining({ code: 'VERIFIER_INCOMPLETE', check: 'NATIVE_SURFACE' })]);
    await session.discard(staged);
    expect(await readdir(root)).not.toContain('document.redacted.docx');
  });

  it('refuses a writer that changed a structural identifier the plan never targeted', async () => {
    const { source, plan, staged, inputBytes } = await stagedRedaction();
    const forged = zip(wordPackage({
      documentText: labels.documentText,
      deletedText: labels.deletedText,
      headerText: labels.headerText,
      commentText: labels.commentText,
      commentAuthor: labels.commentAuthor,
      userId: labels.userId,
      creator: labels.creator,
      paragraphId: '1A2B3C4E'
    }));

    const report = await attest(source, inputBytes, staged.path, plan, { outputBytes: forged });

    expect(report.outcome).toBe('FAIL');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'STRUCTURE_INVALID', check: 'STRUCTURE' }));
  });

  it('refuses a DOCX redaction under a policy that names no DOCX verification profile', async () => {
    const { root, input, output } = await workspace();
    const textOnly = compilePolicy({
      ...bundledPolicies['development-labels'],
      verification: { profile: 'text-rescan-v1', blockOnWarnings: true }
    });

    await expect(localDocxApplication.redact({
      session: createLocalDocxArtifactSession(input, output),
      requirement: docxCapabilityRequirement('REDACT'),
      policy: textOnly
    }, { correlationId: 'cor_docx_redaction_test' })).rejects.toMatchObject({
      code: 'POLICY_UNSATISFIABLE',
      details: { verificationProfileAvailable: false }
    });

    expect(await readdir(root)).toEqual(['document.docx']);
  });

  it('refuses to publish a DOCX redaction attested by the canonical-text verifier', async () => {
    const { root, input, output } = await workspace();

    await expect(localFileApplication.redact({
      session: createLocalDocxArtifactSession(input, output),
      requirement: docxCapabilityRequirement('REDACT'),
      policy
    }, { correlationId: 'cor_docx_redaction_test' })).rejects.toMatchObject({ code: 'VERIFICATION_INCOMPLETE' });

    expect(await readdir(root)).toEqual(['document.docx']);
  });

  it('blocks publication and leaves no output when a forging writer keeps a planted identity', async () => {
    const { input, output, root } = await workspace();
    const session = createLocalDocxArtifactSession(input, output);
    // A writer that applies every label except the presence identity, and signs a receipt over
    // exactly the bytes it wrote, so nothing short of independent verification can catch it.
    const forged = zip(wordPackage({
      documentText: labels.documentText,
      deletedText: labels.deletedText,
      headerText: labels.headerText,
      commentText: labels.commentText,
      commentAuthor: labels.commentAuthor,
      userId: plantedValues.userId,
      creator: labels.creator
    }));

    await expect(localDocxApplication.redact({
      session: {
        ...session,
        async stage(plan, signal) {
          const staged = await session.stage(plan, signal);
          await writeFile(staged.path, forged);
          return {
            ...staged,
            byteLength: forged.length,
            digest: digestOf(forged),
            receipt: receiptFor(plan, digestOf(forged), forged.length)
          };
        }
      },
      requirement: docxCapabilityRequirement('REDACT'),
      policy
    }, { correlationId: 'cor_docx_redaction_test' })).rejects.toMatchObject({ code: 'VERIFICATION_RESIDUAL' });

    expect(await readdir(root)).toEqual(['document.docx']);
  });
});
