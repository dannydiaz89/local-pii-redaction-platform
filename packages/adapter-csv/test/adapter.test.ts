import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSha256Digest, unicodeCodePointLength, type EntityType } from '@local-pii/domain';
import { compileTypedLabelPlan, type TypedLabelPlan } from '@local-pii/redaction';

import {
  createLocalCsvArtifactSession,
  csvWriterDescriptor,
  readCsvArtifact,
  type CsvArtifact
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function csvFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-csv-'));
  roots.push(root);
  const path = join(root, 'document.csv');
  await writeFile(path, content);
  return path;
}

function planFor(
  source: CsvArtifact,
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
    detectorBundleVersion: 'synthetic-csv-test-v1',
    policy: {
      id: 'development-labels',
      version: '0.1.0',
      digest: parseSha256Digest(`sha256:${'3'.repeat(64)}`),
      riskTier: 'LOW'
    },
    writer: csvWriterDescriptor
  });
}

function codePointOffsetOf(text: string, value: string): number {
  const utf16 = text.indexOf(value);
  if (utf16 < 0) throw new Error('Synthetic value is absent.');
  return unicodeCodePointLength(text.slice(0, utf16));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson((value as Readonly<Record<string, unknown>>)[key])}`
  ).join(',')}}`;
}

function stableIdentifier(prefix: 'plan' | 'act', value: unknown): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = createHash('sha256').update(canonicalJson(value), 'utf8').digest().subarray(0, 16);
  let numeric = BigInt(`0x${bytes.toString('hex')}`);
  let encoded = '';
  for (let index = 0; index < 26; index += 1) {
    encoded = `${alphabet.charAt(Number(numeric & 31n))}${encoded}`;
    numeric >>= 5n;
  }
  return `${prefix}_${encoded}`;
}

function planWithReplacement(plan: TypedLabelPlan, replacement: string): TypedLabelPlan {
  if (plan.schemaVersion !== '1.0.0') throw new Error('Synthetic test expects a v1 plan.');
  const original = plan.actions[0];
  if (original === undefined) throw new Error('Synthetic test action is absent.');
  const actionWithoutId = {
    action: original.action,
    sourceSpanId: original.sourceSpanId,
    evidenceIds: original.evidenceIds,
    entityType: original.entityType,
    start: original.start,
    end: original.end,
    replacement
  };
  const action = {
    id: stableIdentifier('act', {
      resolutionDigest: plan.resolutionDigest,
      policyDigest: plan.policy.digest,
      action: actionWithoutId
    }),
    ...actionWithoutId
  };
  const planWithoutIdentity = {
    schemaVersion: plan.schemaVersion,
    strategyVersion: plan.strategyVersion,
    strategy: plan.strategy,
    inputDigest: plan.inputDigest,
    extractionRevision: plan.extractionRevision,
    resolutionDigest: plan.resolutionDigest,
    capabilityDigest: plan.capabilityDigest,
    detectorBundleVersion: plan.detectorBundleVersion,
    policy: plan.policy,
    writer: plan.writer,
    expectedActionCount: plan.expectedActionCount,
    actions: [action]
  };
  const id = stableIdentifier('plan', planWithoutIdentity);
  return {
    id,
    ...planWithoutIdentity,
    digest: parseSha256Digest(`sha256:${createHash('sha256').update(canonicalJson({ id, ...planWithoutIdentity }), 'utf8').digest('hex')}`)
  };
}

describe('CSV adapter', () => {
  it('extracts every decoded cell in row-major order and preserves input bytes and metadata', async () => {
    const raw = 'name,email,note\r\nAlice,alpha@example.test,"hello, world"\r\n';
    const path = await csvFile(raw);
    const before = await stat(path, { bigint: true });

    const artifact = await readCsvArtifact(path);

    expect(artifact.mediaType).toBe('text/csv');
    expect(artifact.text).toBe(['name', 'email', 'note', 'Alice', 'alpha@example.test', 'hello, world'].join('\n\u0000\n'));
    expect(artifact.regions.map(({ location }) => location)).toEqual([
      { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 1, column: 1 },
      { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 1, column: 2 },
      { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 1, column: 3 },
      { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 2, column: 1 },
      { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 2, column: 2 },
      { schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 2, column: 3 }
    ]);
    expect(await readFile(path, 'utf8')).toBe(raw);
    const after = await stat(path, { bigint: true });
    expect({ mode: after.mode, size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs }).toEqual({
      mode: before.mode,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs
    });
  });

  it.each([
    ['semicolon', 'name;value\nalpha;"x;y"\n', ['name', 'value', 'alpha', 'x;y']],
    ['tab', 'name\tvalue\nalpha\t"x\ty"\n', ['name', 'value', 'alpha', 'x\ty']],
    ['quoted newline', 'name,note\nalpha,"line one\nline two"\n', ['name', 'note', 'alpha', 'line one\nline two']],
    ['single column', 'alpha@example.test\nsecond\n', ['alpha@example.test', 'second']]
  ])('supports %s input without normalizing its dialect', async (_name, raw, values) => {
    const artifact = await readCsvArtifact(await csvFile(raw));
    expect(artifact.text).toBe(values.join('\n\u0000\n'));
    if (_name === 'quoted newline') {
      expect(artifact.regions[3]?.location).toEqual({
        schemaVersion: '1.0.0', kind: 'CSV_CELL', row: 2, column: 2
      });
    }
  });

  it.each([
    ['unterminated quote', 'a,b\n1,"private-canary\n'],
    ['text after quote', 'a,b\n1,"x"tail\n'],
    ['inconsistent width', 'a,b\n1,2,3\n'],
    ['ambiguous dialect', 'a,b;c\n1,2;3\n']
  ])('fails closed for %s with a value-free error', async (_name, raw) => {
    await expect(readCsvArtifact(await csvFile(raw))).rejects.toMatchObject({
      code: 'FORMAT_CORRUPT',
      message: 'The CSV input is malformed, ambiguous, or exceeds the supported structural limits.'
    });
  });

  it('rewrites only changed cells with Unicode-safe offsets and preserves untouched quoted tokens', async () => {
    const raw = 'name,email,note\r\nAlice,"😀 alpha@example.test","keep ""quoted"", value"\r\n';
    const input = await csvFile(raw);
    const output = join(roots.at(-1) ?? '', 'document.redacted.csv');
    const session = createLocalCsvArtifactSession(input, output);
    const source = await session.input();
    const value = 'alpha@example.test';
    const start = codePointOffsetOf(source.text, value);

    const staged = await session.stage(planFor(source, [{ start, end: start + unicodeCodePointLength(value) }]));

    expect(await readFile(staged.reference, 'utf8')).toBe(
      'name,email,note\r\nAlice,"😀 [EMAIL_1]","keep ""quoted"", value"\r\n'
    );
    const reopened = await session.reopen(staged);
    expect(reopened.text).toContain('😀 [EMAIL_1]');
    expect(staged.receipt.appliedActionIds).toHaveLength(1);
    await session.discard(staged);
  });

  it('handles dense changes across cells in one document pass', async () => {
    const values = Array.from({ length: 1_000 }, () => 'x');
    const input = await csvFile(values.join(',') + '\n');
    const session = createLocalCsvArtifactSession(input, join(roots.at(-1) ?? '', 'document.redacted.csv'));
    const source = await session.input();
    const spans = values.map((_value, index) => ({ start: index * 4, end: index * 4 + 1 }));

    const staged = await session.stage(planFor(source, spans));
    const result = await readFile(staged.reference, 'utf8');
    expect(result.match(/\[EMAIL_[0-9]+\]/gu)).toHaveLength(1_000);
    expect(result).not.toContain('x');
    await session.discard(staged);
  });

  it('quotes alternate supported delimiters introduced by a valid custom plan', async () => {
    const input = await csvFile('alpha@example.test\n');
    const session = createLocalCsvArtifactSession(input, join(roots.at(-1) ?? '', 'document.redacted.csv'));
    const source = await session.input();
    const plan = planFor(source, [{ start: 0, end: unicodeCodePointLength(source.text) }]);

    const staged = await session.stage(planWithReplacement(plan, 'safe;second'));

    expect(await readFile(staged.reference, 'utf8')).toBe('"safe;second"\n');
    expect((await session.reopen(staged)).text).toBe('safe;second');
    await session.discard(staged);
  });

  it.each([
    ['zero-length', [{ start: 1, end: 1 }]],
    ['reversed', [{ start: 2, end: 1 }]],
    ['cross-cell', [{ start: 2, end: 7 }]],
    ['overlapping', [{ start: 0, end: 2 }, { start: 1, end: 3 }]]
  ])('rejects a self-consistent %s plan before creating a stage', async (_name, spans) => {
    const input = await csvFile('abc,def\n');
    const root = roots.at(-1) ?? '';
    const session = createLocalCsvArtifactSession(input, join(root, 'document.redacted.csv'));
    const source = await session.input();

    await expect(session.stage(planFor(source, spans))).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    expect(await readdir(root)).toEqual(['document.csv']);
  });

  it('requires CSV input/output extensions and a valid configured byte bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-csv-'));
    roots.push(root);
    const wrong = join(root, 'document.txt');
    await writeFile(wrong, 'a,b\n');
    await expect(readCsvArtifact(wrong)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
    expect(() => createLocalCsvArtifactSession(wrong, undefined, Number.POSITIVE_INFINITY)).toThrow(TypeError);

    const input = await csvFile('a,b\n');
    const session = createLocalCsvArtifactSession(input, join(roots.at(-1) ?? '', 'document.txt'));
    const source = await session.input();
    await expect(session.stage(planFor(source, []))).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
  });
});
