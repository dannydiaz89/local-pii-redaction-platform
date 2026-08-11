import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SafeError } from '@local-pii/domain';

import {
  createLocalPdfArtifactSession,
  extractPdfBytes,
  pdfAdapterCapabilityDescriptor,
  probePdfBytes,
  readPdfArtifact
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function expectSafeError(
  operation: () => unknown,
  code: SafeError['code'],
  reason?: string
): void {
  let caught: unknown;
  try { operation(); } catch (error: unknown) { caught = error; }
  expect(caught).toBeInstanceOf(SafeError);
  if (!(caught instanceof SafeError)) throw new TypeError('Expected a privacy-safe PDF error.');
  expect(caught.code).toBe(code);
  if (reason !== undefined) expect(caught.details).toEqual({ reason });
}

function syntheticPdf(
  pageLines: readonly (readonly string[])[],
  options: Readonly<{
    extraObjects?: readonly string[];
    fontBody?: string;
    contentSuffix?: string;
    origin?: string;
  }> = {}
): Buffer {
  const font = options.fontBody
    ?? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n';
  const pageReferences = pageLines.map((_lines, index) => 4 + index * 2);
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>\n`,
    `<< /Type /Pages /Kids [${pageReferences.map((reference) => `${String(reference)} 0 R`).join(' ')}] /Count ${String(pageReferences.length)} >>\n`,
    font
  ];
  for (const [index, lines] of pageLines.entries()) {
    const page = 4 + index * 2;
    const content = page + 1;
    const commands = [
      'BT',
      '/F1 12 Tf',
      options.origin ?? '72 720 Td',
      ...lines.flatMap((line, lineIndex) => [
        `(${line.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj`,
        ...(lineIndex === lines.length - 1 ? [] : ['0 -18 Td'])
      ]),
      options.contentSuffix ?? 'ET'
    ].join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${String(content)} 0 R >>\n`);
    objects.push(`<< /Length ${String(commands.length)} >>\nstream\n${commands}\nendstream\n`);
  }
  objects.push(...(options.extraObjects ?? []));

  const header = '%PDF-1.4\n';
  let body = '';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(header.length + body.length);
    body += `${String(index + 1)} 0 obj\n${object}endobj\n`;
  }
  const xrefOffset = header.length + body.length;
  const entries = offsets.map((offset, index) => index === 0
    ? '0000000000 65535 f \n'
    : `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  const xref = `xref\n0 ${String(objects.length + 1)}\n${entries}trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(header + body + xref, 'ascii');
}

describe('strict extraction-only PDF adapter', () => {
  it('extracts every accepted literal in deterministic page/operator order', () => {
    const bytes = syntheticPdf([
      ['alpha@example.test', 'Call 202-555-0198'],
      ['Second page']
    ]);
    expect(probePdfBytes(bytes)).toBe(true);
    const extracted = extractPdfBytes(bytes);
    expect(extracted.text).toBe('alpha@example.test\nCall 202-555-0198\n\u0000PDF-PAGE\u0000\nSecond page');
    expect(extracted.pageCount).toBe(2);
    expect(extracted.regions).toEqual([
      {
        schemaVersion: '3.0.0', start: 0, end: 18, offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
        location: {
          schemaVersion: '3.0.0', kind: 'PDF_TEXT_ITEM', page: 1, pageObject: 4,
          contentObject: 5, fontObject: 3, textItem: 1, glyphCount: 18
        }
      },
      {
        schemaVersion: '3.0.0', start: 19, end: 36, offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
        location: {
          schemaVersion: '3.0.0', kind: 'PDF_TEXT_ITEM', page: 1, pageObject: 4,
          contentObject: 5, fontObject: 3, textItem: 2, glyphCount: 17
        }
      },
      {
        schemaVersion: '3.0.0', start: 48, end: 59, offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
        location: {
          schemaVersion: '3.0.0', kind: 'PDF_TEXT_ITEM', page: 2, pageObject: 6,
          contentObject: 7, fontObject: 3, textItem: 1, glyphCount: 11
        }
      }
    ]);
    expect(Object.isFrozen(extracted.regions)).toBe(true);
    expect(extracted.regions.every((region) => Object.isFrozen(region) && Object.isFrozen(region.location))).toBe(true);
    expect(pdfAdapterCapabilityDescriptor.operations).toEqual(['PROBE', 'INSPECT']);
    expect(pdfAdapterCapabilityDescriptor.assurance).toBe('EXTRACT_ONLY');
  });

  it('reads without changing input bytes or metadata', async () => {
    const directory = await temporaryDirectory('local-pii-pdf-');
    const path = join(directory, 'synthetic.pdf');
    const bytes = syntheticPdf([['person@example.test']]);
    await writeFile(path, bytes, { mode: 0o640 });
    const before = await stat(path, { bigint: true });
    const artifact = await readPdfArtifact(path);
    const after = await stat(path, { bigint: true });
    expect(artifact.text).toBe('person@example.test');
    expect(artifact.pageCount).toBe(1);
    expect(artifact.regions).toHaveLength(1);
    expect(await readFile(path)).toEqual(bytes);
    expect({ ino: after.ino, mode: after.mode, size: after.size, mtimeNs: after.mtimeNs }).toEqual({
      ino: before.ino, mode: before.mode, size: before.size, mtimeNs: before.mtimeNs
    });
  });

  it('maps decoded glyph counts rather than escaped PDF source bytes', () => {
    const extracted = extractPdfBytes(syntheticPdf([['A(B)\\C']]));
    expect(extracted.text).toBe('A(B)\\C');
    expect(extracted.regions).toEqual([{
      schemaVersion: '3.0.0', start: 0, end: 6, offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
      location: {
        schemaVersion: '3.0.0', kind: 'PDF_TEXT_ITEM', page: 1, pageObject: 4,
        contentObject: 5, fontObject: 3, textItem: 1, glyphCount: 6
      }
    }]);
  });

  it.each([
    ['/Encrypt <<>>', 'encrypted'],
    ['/JavaScript (noop)', 'active_content'],
    ['/Launch <<>>', 'active_content'],
    ['/EmbeddedFile <<>>', 'attachments'],
    ['/AcroForm <<>>', 'forms_or_annotations'],
    ['/Metadata 1 0 R', 'metadata'],
    ['/Prev 1', 'incremental_update']
  ])('rejects an unscanned carrier with a closed safe reason: %s', (feature, reason) => {
    const bytes = syntheticPdf([['safe']], { extraObjects: [`<< ${feature} >>\n`] });
    expectSafeError(() => extractPdfBytes(bytes), 'FORMAT_UNSUPPORTED', reason);
  });

  it.each([
    '/OCProperties <<>>',
    '/Subtype /Image',
    '/Subtype /Form',
    '/Filter /FlateDecode',
    '/ObjStm <<>>',
    '/Pattern <<>>'
  ])('rejects every unknown visual or compressed carrier rather than skipping it: %s', (feature) => {
    expectSafeError(
      () => extractPdfBytes(syntheticPdf([['safe']], { extraObjects: [`<< ${feature} >>\n`] })),
      'FORMAT_UNSUPPORTED'
    );
  });

  it('rejects alternate encodings, unknown operators, hidden/off-page positions, and malformed xref', () => {
    expectSafeError(() => extractPdfBytes(syntheticPdf([['safe']], {
      fontBody: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /MacRomanEncoding >>\n'
    })), 'FORMAT_UNSUPPORTED', 'unsupported_encoding');
    expectSafeError(
      () => extractPdfBytes(syntheticPdf([['safe']], { contentSuffix: '0 Tr\nET' })),
      'FORMAT_UNSUPPORTED'
    );
    expectSafeError(
      () => extractPdfBytes(syntheticPdf([['safe']], { origin: '600 720 Td' })),
      'FORMAT_UNSUPPORTED'
    );
    expectSafeError(() => extractPdfBytes(syntheticPdf([['@'.repeat(41)]])), 'FORMAT_UNSUPPORTED');
    const corrupt = syntheticPdf([['safe']]);
    corrupt[corrupt.indexOf(Buffer.from('0000000009'))] = 0x38;
    expectSafeError(() => extractPdfBytes(corrupt), 'FORMAT_CORRUPT');
  });

  it('rejects selected-file symlinks and keeps errors free of paths and planted values', async () => {
    const directory = await temporaryDirectory('local-pii-pdf-link-');
    const source = join(directory, 'canary-source.pdf');
    const link = join(directory, 'canary-link.pdf');
    await writeFile(source, syntheticPdf([['PLANTED-PDF-CANARY']]));
    await symlink(source, link);
    let caught: unknown;
    try { await readPdfArtifact(link); } catch (error: unknown) { caught = error; }
    expect(caught).toBeInstanceOf(SafeError);
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain('PLANTED-PDF-CANARY');
    expect(serialized).not.toMatch(/E[A-Z]{2,}/u);
  });

  it('keeps all writer operations unavailable even for an accepted PDF', async () => {
    const directory = await temporaryDirectory('local-pii-pdf-writer-');
    const path = join(directory, 'synthetic.pdf');
    await writeFile(path, syntheticPdf([['safe']]));
    const session = createLocalPdfArtifactSession(path);
    await expect(session.stage({})).rejects.toMatchObject({ code: 'FORMAT_UNSUPPORTED' });
  });
});
