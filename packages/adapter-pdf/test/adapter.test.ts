import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

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

function captureSafeError(operation: () => unknown): SafeError {
  let caught: unknown;
  try { operation(); } catch (error: unknown) { caught = error; }
  expect(caught).toBeInstanceOf(SafeError);
  if (!(caught instanceof SafeError)) throw new TypeError('Expected a privacy-safe PDF error.');
  return caught;
}

function expectSafeError(
  operation: () => unknown,
  code: SafeError['code'],
  reason?: string
): void {
  const caught = captureSafeError(operation);
  expect(caught.code).toBe(code);
  if (reason !== undefined) expect(caught.details).toEqual({ reason });
}

function syntheticPdf(
  pageLines: readonly (readonly string[])[],
  options: Readonly<{
    extraObjects?: readonly string[];
    catalogSuffix?: string;
    fontBody?: string;
    contentSuffix?: string;
    contentDictionarySuffix?: string;
    flate?: boolean;
    flateTrailer?: string;
    origin?: string;
    binaryMarkerLength?: number;
    pdfVersion?: '1.4' | '1.7';
    trailerSuffix?: string;
  }> = {}
): Buffer {
  const font = options.fontBody
    ?? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n';
  const pageReferences = pageLines.map((_lines, index) => 4 + index * 2);
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R${options.catalogSuffix ?? ''} >>\n`,
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
    let payload = commands;
    if (options.flate === true) {
      const encoded = deflateSync(Buffer.from(commands, 'ascii'));
      payload = `${encoded.toString('latin1')}${options.flateTrailer ?? ''}`;
      encoded.fill(0);
    }
    const dictionarySuffix = options.contentDictionarySuffix
      ?? (options.flate === true ? ' /Filter /FlateDecode' : '');
    objects.push(`<< /Length ${String(payload.length)}${dictionarySuffix} >>\nstream\n${payload}\nendstream\n`);
  }
  objects.push(...(options.extraObjects ?? []));

  const header = options.pdfVersion === '1.7'
    ? `%PDF-1.7\n%${Buffer.alloc(options.binaryMarkerLength ?? 4, 0xe2).toString('latin1')}\n`
    : '%PDF-1.4\n';
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
  const xref = `xref\n0 ${String(objects.length + 1)}\n${entries}trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R${options.trailerSuffix ?? ''} >>\nstartxref\n${String(xrefOffset)}\n%%EOF\n`;
  return Buffer.from(header + body + xref, 'latin1');
}

function utf16BeHex(value: string): string {
  const bytes = Buffer.alloc(2 + value.length * 2);
  bytes[0] = 0xfe;
  bytes[1] = 0xff;
  for (let index = 0; index < value.length; index += 1) bytes.writeUInt16BE(value.charCodeAt(index), 2 + index * 2);
  const encoded = bytes.toString('hex').toUpperCase();
  bytes.fill(0);
  return encoded;
}

function xmpObject(xml: string): string {
  return `<< /Type /Metadata /Subtype /XML /Length ${String(Buffer.byteLength(xml, 'utf8'))} >>\nstream\n${xml}\nendstream\n`;
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
    const bytes = syntheticPdf([['person@example.test']], { flate: true, pdfVersion: '1.7' });
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

  it('extracts the same complete map from one bounded Flate stream under a binary PDF 1.7 header', () => {
    const bytes = syntheticPdf([['alpha@example.test', 'Call 202-555-0198']], {
      flate: true,
      pdfVersion: '1.7'
    });
    expect(probePdfBytes(bytes)).toBe(true);
    const extracted = extractPdfBytes(bytes);
    expect(extracted.text).toBe('alpha@example.test\nCall 202-555-0198');
    expect(extracted.regions.map(({ start, end, location }) => ({
      start, end, page: location.kind === 'PDF_TEXT_ITEM' ? location.page : 0,
      textItem: location.kind === 'PDF_TEXT_ITEM' ? location.textItem : 0,
      glyphCount: location.kind === 'PDF_TEXT_ITEM' ? location.glyphCount : 0
    }))).toEqual([
      { start: 0, end: 18, page: 1, textItem: 1, glyphCount: 18 },
      { start: 19, end: 36, page: 1, textItem: 2, glyphCount: 17 }
    ]);
    expect(pdfAdapterCapabilityDescriptor.features).toContainEqual({
      id: 'bounded-flate-content-stream', status: 'SUPPORTED'
    });
    expect(pdfAdapterCapabilityDescriptor.operations).toEqual(['PROBE', 'INSPECT']);
  });

  it('fails closed for malformed, trailing, over-expanding, or parameterized Flate data', () => {
    const malformed = syntheticPdf([['PLANTED-FLATE-CANARY']], { flate: true, pdfVersion: '1.7' });
    const payloadStart = malformed.indexOf(Buffer.from('stream\n', 'ascii')) + 'stream\n'.length;
    malformed[payloadStart] = (malformed[payloadStart] ?? 0) ^ 0xff;
    expectSafeError(() => extractPdfBytes(malformed), 'FORMAT_CORRUPT');
    expectSafeError(() => extractPdfBytes(syntheticPdf([['safe']], {
      flate: true,
      flateTrailer: 'JUNK',
      pdfVersion: '1.7'
    })), 'FORMAT_CORRUPT');
    expectSafeError(() => extractPdfBytes(syntheticPdf([['A'.repeat(4_000)]], {
      flate: true,
      pdfVersion: '1.7'
    })), 'FORMAT_CORRUPT');
    expectSafeError(() => extractPdfBytes(syntheticPdf([['safe']], {
      flate: true,
      contentDictionarySuffix: ' /Filter /FlateDecode /DecodeParms << /Predictor 12 >>',
      pdfVersion: '1.7'
    })), 'FORMAT_UNSUPPORTED');
    for (const bytes of [malformed, syntheticPdf([['PLANTED-FLATE-CANARY']], {
      flate: true,
      flateTrailer: 'JUNK',
      pdfVersion: '1.7'
    })]) {
      expect(JSON.stringify(captureSafeError(() => extractPdfBytes(bytes)))).not.toContain('PLANTED-FLATE-CANARY');
    }
  });

  it('requires a bounded all-binary comment for PDF 1.7 and rejects binary syntax elsewhere', () => {
    const noMarker = syntheticPdf([['safe']], { pdfVersion: '1.7' });
    const markerStart = Buffer.byteLength('%PDF-1.7\n', 'ascii');
    noMarker.fill(0x20, markerStart + 1, markerStart + 5);
    expect(probePdfBytes(noMarker)).toBe(false);
    expectSafeError(() => extractPdfBytes(noMarker), 'FORMAT_CORRUPT');
    for (const binaryMarkerLength of [3, 17]) {
      const outOfBounds = syntheticPdf([['safe']], { pdfVersion: '1.7', binaryMarkerLength });
      expect(probePdfBytes(outOfBounds)).toBe(false);
      expectSafeError(() => extractPdfBytes(outOfBounds), 'FORMAT_CORRUPT');
    }
    const upperBound = syntheticPdf([['safe']], { pdfVersion: '1.7', binaryMarkerLength: 16 });
    expect(probePdfBytes(upperBound)).toBe(true);
    expect(extractPdfBytes(upperBound).text).toBe('safe');

    const unexpectedBinary = syntheticPdf([['safe']]);
    const catalogStart = unexpectedBinary.indexOf(Buffer.from('/Catalog', 'ascii'));
    unexpectedBinary[catalogStart] = 0xff;
    expectSafeError(() => extractPdfBytes(unexpectedBinary), 'FORMAT_UNSUPPORTED');
  });

  it('accepts only an exact value-free XYZ OpenAction destination bound to a declared page', () => {
    const extracted = extractPdfBytes(syntheticPdf([['safe']], {
      catalogSuffix: ' /OpenAction [4 0 R /XYZ null null 0]',
      flate: true,
      pdfVersion: '1.7'
    }));
    expect(extracted.text).toBe('safe');
    expect(extracted.regions).toEqual([{
      schemaVersion: '3.0.0', start: 0, end: 4, offsetUnit: 'UNICODE_CODE_POINT', role: 'VALUE',
      location: {
        schemaVersion: '3.0.0', kind: 'PDF_TEXT_ITEM', page: 1, pageObject: 4,
        contentObject: 5, fontObject: 3, textItem: 1, glyphCount: 4
      }
    }]);
    expect(pdfAdapterCapabilityDescriptor.features).toContainEqual({
      id: 'value-free-open-action-xyz-destination', status: 'SUPPORTED'
    });
    expect(extractPdfBytes(syntheticPdf([['safe']], {
      catalogSuffix: ' /OpenAction[4 0 R /XYZ null null 0]'
    })).text).toBe('safe');

    expectSafeError(() => extractPdfBytes(syntheticPdf([['safe']], {
      catalogSuffix: ' /OpenAction [99 0 R /XYZ null null 0]'
    })), 'FORMAT_CORRUPT');
  });

  it('keeps every executable or value-bearing OpenAction shape blocked', () => {
    for (const catalogSuffix of [
      ' /OpenAction << /S /JavaScript /JS (PLANTED-ACTION-CANARY) >>',
      ' /OpenAction (PLANTED-ACTION-CANARY)',
      ' /OpenAction /PLANTED-ACTION-CANARY',
      ' /OpenAction [4 0 R /Fit]',
      ' /OpenAction 8 0 R'
    ]) {
      const error = captureSafeError(() => extractPdfBytes(syntheticPdf([['safe']], { catalogSuffix })));
      expect(error).toMatchObject({ code: 'FORMAT_UNSUPPORTED', details: { reason: 'active_content' } });
      expect(JSON.stringify(error)).not.toContain('PLANTED-ACTION-CANARY');
    }
  });

  it('extracts every accepted Info and XMP value into typed metadata regions', () => {
    const xml = [
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
      '<dc:format>application/pdf</dc:format>',
      '<dc:creator><rdf:Seq><rdf:li>Example Person</rdf:li></rdf:Seq></dc:creator>',
      '</rdf:Description></rdf:RDF></x:xmpmeta>',
      '<?xpacket end="w"?>'
    ].join('');
    const bytes = syntheticPdf([['safe']], {
      catalogSuffix: ' /Metadata 7 0 R',
      extraObjects: [
        `<< /Author <${utf16BeHex('Example Person')}> /CreationDate (D:20000101000000Z) >>\n`,
        xmpObject(xml)
      ],
      trailerSuffix: ' /Info 6 0 R'
    });
    const extracted = extractPdfBytes(bytes);
    expect(extracted.text).toBe([
      'safe', '\u0000PDF-METADATA\u0000', 'Example Person', 'D:20000101000000Z',
      'application/pdf', 'Example Person'
    ].join('\n'));
    expect(extracted.regions.slice(1).map(({ location }) => location)).toEqual([
      { schemaVersion: '4.0.0', kind: 'PDF_METADATA_VALUE', carrier: 'INFO', object: 6, field: 'AUTHOR', occurrence: 1 },
      { schemaVersion: '4.0.0', kind: 'PDF_METADATA_VALUE', carrier: 'INFO', object: 6, field: 'CREATION_DATE', occurrence: 1 },
      { schemaVersion: '4.0.0', kind: 'PDF_METADATA_VALUE', carrier: 'XMP', object: 7, field: 'DC_FORMAT', occurrence: 1 },
      { schemaVersion: '4.0.0', kind: 'PDF_METADATA_VALUE', carrier: 'XMP', object: 7, field: 'DC_CREATOR', occurrence: 1 }
    ]);
    expect(pdfAdapterCapabilityDescriptor.operations).toEqual(['PROBE', 'INSPECT']);
  });

  it('rejects document IDs, unknown XMP carriers, and malformed metadata without exposing values', () => {
    const invalidCases = [
      syntheticPdf([['safe']], { trailerSuffix: ' /ID [<0011> <0011>]' }),
      syntheticPdf([['safe']], {
        catalogSuffix: ' /Metadata 7 0 R',
        extraObjects: [
          '<< /Author (PLANTED-METADATA-CANARY) >>\n',
          xmpObject('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><unknown:value>PLANTED-METADATA-CANARY</unknown:value></x:xmpmeta><?xpacket end="w"?>')
        ],
        trailerSuffix: ' /Info 6 0 R'
      }),
      syntheticPdf([['safe']], {
        catalogSuffix: ' /Metadata 7 0 R',
        extraObjects: ['<< /Author <FEFFD800> >>\n', xmpObject('malformed')],
        trailerSuffix: ' /Info 6 0 R'
      })
    ];
    for (const bytes of invalidCases) {
      const error = captureSafeError(() => extractPdfBytes(bytes));
      expect(error.code === 'FORMAT_UNSUPPORTED' || error.code === 'FORMAT_CORRUPT').toBe(true);
      expect(JSON.stringify(error)).not.toContain('PLANTED-METADATA-CANARY');
    }
  });

  it('requires an exact namespace-bound XMP packet tree and keeps rejected values private', () => {
    const packet = (body: string, suffix = ''): string => [
      '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>',
      body,
      '<?xpacket end="w"?>',
      suffix
    ].join('');
    const description = (body: string, attributes = ''): string => [
      '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
      `<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"${attributes}>`,
      body,
      '</rdf:Description></rdf:RDF></x:xmpmeta>'
    ].join('');
    const invalidXml = [
      packet('<dc:title>PLANTED-METADATA-CANARY</dc:title>'),
      packet(description('<dc:title>PLANTED-METADATA-CANARY</dc:title>').replace(
        'http://purl.org/dc/elements/1.1/',
        'urn:spoofed'
      )),
      packet(description('<dc:title>PLANTED-METADATA-CANARY</dc:title>', ' rdf:about=""')),
      `<dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">PLANTED-METADATA-CANARY</dc:title>${packet(description('<dc:title>safe</dc:title>'))}`,
      packet(description('<dc:title>safe</dc:title>'), '<dc:title>PLANTED-METADATA-CANARY</dc:title>'),
      packet(description('<rdf:li>PLANTED-METADATA-CANARY</rdf:li>')),
      packet(description('<dc:title>safe</dc:title>') + description('<dc:title>PLANTED-METADATA-CANARY</dc:title>')),
      packet(description('<dc:title raw="PLANTED<METADATA-CANARY">safe</dc:title>'))
    ];
    for (const xml of invalidXml) {
      const bytes = syntheticPdf([['safe']], {
        catalogSuffix: ' /Metadata 7 0 R',
        extraObjects: ['<< /Author (PLANTED-METADATA-CANARY) >>\n', xmpObject(xml)],
        trailerSuffix: ' /Info 6 0 R'
      });
      const error = captureSafeError(() => extractPdfBytes(bytes));
      expect(error.code === 'FORMAT_UNSUPPORTED' || error.code === 'FORMAT_CORRUPT').toBe(true);
      expect(JSON.stringify(error)).not.toContain('PLANTED-METADATA-CANARY');
    }
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
