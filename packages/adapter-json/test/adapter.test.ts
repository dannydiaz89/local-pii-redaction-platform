import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseSha256Digest, unicodeCodePointLength, type EntityType } from '@local-pii/domain';
import { compileTypedLabelPlan } from '@local-pii/redaction';

import {
  createLocalJsonArtifactSession,
  jsonWriterDescriptor,
  readJsonArtifact,
  type JsonArtifact
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function jsonFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-json-'));
  roots.push(root);
  const path = join(root, 'document.json');
  await writeFile(path, content);
  return path;
}

function planFor(
  source: JsonArtifact,
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
    detectorBundleVersion: 'synthetic-json-test-v1',
    policy: {
      id: 'development-labels',
      version: '0.1.0',
      digest: parseSha256Digest(`sha256:${'3'.repeat(64)}`),
      riskTier: 'LOW'
    },
    writer: jsonWriterDescriptor
  });
}

function codePointOffsetOf(text: string, value: string): number {
  const utf16 = text.indexOf(value);
  if (utf16 < 0) throw new Error('Synthetic test value is absent.');
  return unicodeCodePointLength(text.slice(0, utf16));
}

describe('JSON adapter extraction', () => {
  it('extracts only string values in document order and leaves input bytes and metadata unchanged', async () => {
    const raw = '{\n  "key@example.test": "alpha@example.test",\n  "nested": [42, true, null, "☎️ +1 202-555-0147"],\n  "a/b~c": {"label": "safe"}\n}\n';
    const path = await jsonFile(raw);
    const before = await stat(path, { bigint: true });

    const artifact = await readJsonArtifact(path);

    expect(artifact.mediaType).toBe('application/json');
    expect(artifact.text).toBe(['alpha@example.test', '☎️ +1 202-555-0147', 'safe'].join('\n\u0000\n'));
    expect(artifact.text).not.toContain('key@example.test');
    expect(artifact.regions.map(({ location }) => location)).toEqual([
      { schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '/key@example.test' },
      { schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '/nested/3' },
      { schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '/a~1b~0c/label' }
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

  it('supports root strings, astral characters, and escaped JSON strings with portable code-point extraction', async () => {
    const path = await jsonFile('"prefix \\ud83d\\ude00 alpha@example.test\\nend"');
    const artifact = await readJsonArtifact(path);
    expect(artifact.text).toBe('prefix 😀 alpha@example.test\nend');
    expect(artifact.extractionRevision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(artifact.regions).toEqual([{
      schemaVersion: '1.0.0',
      start: 0,
      end: unicodeCodePointLength(artifact.text),
      offsetUnit: 'UNICODE_CODE_POINT',
      role: 'VALUE',
      location: { schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '' }
    }]);
  });

  it.each([
    ['duplicate keys', '{"same":"one","same":"two"}'],
    ['trailing data', '{"value":"safe"} false'],
    ['comments', '{"value":"safe" // no comments\n}'],
    ['trailing commas', '{"value":"safe",}'],
    ['lone surrogate', '{"value":"\\ud800"}']
  ])('fails closed for %s without echoing document values', async (_name, raw) => {
    const path = await jsonFile(raw);
    await expect(readJsonArtifact(path)).rejects.toMatchObject({
      code: 'FORMAT_CORRUPT',
      message: 'The JSON input is malformed or exceeds the supported structural limits.'
    });
  });

  it('requires the explicit JSON extension and configured byte bound', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-json-'));
    roots.push(root);
    const textPath = join(root, 'document.txt');
    await writeFile(textPath, '{"value":"safe"}');
    await expect(readJsonArtifact(textPath)).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });

    const jsonPath = await jsonFile('{"value":"safe"}');
    await expect(readJsonArtifact(jsonPath, 1)).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
  });

  it('binds JSON Pointer location into the extraction revision without exposing pointers', async () => {
    const left = await readJsonArtifact(await jsonFile('{"left":"same"}'));
    const right = await readJsonArtifact(await jsonFile('{"right":"same"}'));
    expect(left.text).toBe(right.text);
    expect(left.extractionRevision).not.toBe(right.extractionRevision);
    expect(left.regions[0]?.location).toEqual({ schemaVersion: '1.0.0', kind: 'JSON_POINTER', pointer: '/left' });
    expect(Object.keys(left)).not.toContain('rawText');
  });

  it('rejects excessive nesting under a deterministic parser bound', async () => {
    const nested = `${'['.repeat(130)}"safe"${']'.repeat(130)}`;
    await expect(readJsonArtifact(await jsonFile(nested))).rejects.toMatchObject({ code: 'FORMAT_CORRUPT' });
  });

  it('maps multiple astral-aware actions into native values while preserving untouched token bytes', async () => {
    const raw = '{"untouched":"keep\\u0020escape","email":"😀 alpha@example.test","phone":"+1 202-555-0147","number":42}';
    const input = await jsonFile(raw);
    const output = join(roots.at(-1) ?? '', 'document.redacted.json');
    const session = createLocalJsonArtifactSession(input, output);
    const source = await session.input();
    const email = 'alpha@example.test';
    const phone = '+1 202-555-0147';
    const emailStart = codePointOffsetOf(source.text, email);
    const phoneStart = codePointOffsetOf(source.text, phone);
    const plan = planFor(source, [
      { start: emailStart, end: emailStart + unicodeCodePointLength(email), entityType: 'EMAIL' },
      { start: phoneStart, end: phoneStart + unicodeCodePointLength(phone), entityType: 'PHONE' }
    ]);

    const staged = await session.stage(plan);
    expect(await readFile(staged.reference, 'utf8')).toBe(
      '{"untouched":"keep\\u0020escape","email":"😀 [EMAIL_1]","phone":"[PHONE_1]","number":42}'
    );
    expect(staged.receipt.appliedActionIds).toEqual(plan.actions.map(({ id }) => id));
    const reopened = await session.reopen(staged);
    expect(reopened.text).toContain('😀 [EMAIL_1]');
    expect(reopened.text).not.toContain(email);
    await session.discard(staged);
    await expect(readFile(staged.reference, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies a dense astral-aware action set with one monotonic value walk', async () => {
    const value = '😀x'.repeat(1_000);
    const input = await jsonFile(JSON.stringify({ value }));
    const root = roots.at(-1) ?? '';
    const session = createLocalJsonArtifactSession(input, join(root, 'document.redacted.json'));
    const source = await session.input();
    const spans = Array.from({ length: 1_000 }, (_, index) => ({
      start: index * 2 + 1,
      end: index * 2 + 2,
      entityType: 'EMAIL' as const
    }));

    const staged = await session.stage(planFor(source, spans));
    const parsed = JSON.parse(await readFile(staged.reference, 'utf8')) as { readonly value: string };
    expect(parsed.value.match(/\[EMAIL_[0-9]+\]/gu)).toHaveLength(1_000);
    expect(parsed.value.match(/😀/gu)).toHaveLength(1_000);
    expect(parsed.value).not.toContain('x');
    await session.discard(staged);
  });

  it('assembles a dense set of changed JSON value regions in one document pass', async () => {
    const values = Array.from({ length: 1_000 }, () => 'x');
    const input = await jsonFile(JSON.stringify(values));
    const root = roots.at(-1) ?? '';
    const session = createLocalJsonArtifactSession(input, join(root, 'document.redacted.json'));
    const source = await session.input();
    const spans = values.map((_value, index) => ({
      start: index * 4,
      end: index * 4 + 1,
      entityType: 'EMAIL' as const
    }));

    const staged = await session.stage(planFor(source, spans));
    const parsed = JSON.parse(await readFile(staged.reference, 'utf8')) as string[];
    expect(parsed).toHaveLength(1_000);
    expect(parsed[0]).toBe('[EMAIL_1]');
    expect(parsed[999]).toBe('[EMAIL_1000]');
    expect(parsed.every((value) => !value.includes('x'))).toBe(true);
    await session.discard(staged);
  });

  it.each([
    ['zero-length span', [{ start: 1, end: 1 }]],
    ['reversed span', [{ start: 2, end: 1 }]],
    ['cross-value span', [{ start: 2, end: 7 }]],
    ['overlapping spans', [{ start: 0, end: 2 }, { start: 1, end: 3 }]]
  ])('rejects a self-consistent plan with a %s before creating a stage', async (_name, spans) => {
    const input = await jsonFile('{"left":"abc","right":"def"}');
    const root = roots.at(-1) ?? '';
    const output = join(root, 'document.redacted.json');
    const session = createLocalJsonArtifactSession(input, output);
    const source = await session.input();
    const plan = planFor(source, spans);

    await expect(session.stage(plan)).rejects.toMatchObject({ code: 'REDACTION_PLAN_CONFLICT' });
    expect(await readdir(root)).toEqual(['document.json']);
  });
});
