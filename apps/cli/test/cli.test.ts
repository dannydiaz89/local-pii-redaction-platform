import { copyFile, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeCli, type CliIo } from '../src/commands.js';
import { createProcessSignalController } from '../src/signals.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ readonly root: string; readonly input: string; readonly output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-cli-'));
  directories.push(root);
  const input = join(root, 'source.txt');
  const output = join(root, 'source.redacted.txt');
  await writeFile(input, [
    'Contact alpha@example.test.',
    'SSN 123-45-6789.',
    'Card 4242 4242 4242 4242.',
    'Server 192.0.2.10.',
    'api_key=synthetic_value_12345'
  ].join('\n'));
  return { root, input, output };
}

async function jsonFileForCli(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-json-cli-'));
  directories.push(root);
  const input = join(root, 'document.json');
  await writeFile(input, content);
  return input;
}

async function csvFileForCli(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-csv-cli-'));
  directories.push(root);
  const input = join(root, 'document.csv');
  await writeFile(input, content);
  return input;
}

const docxCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function docxCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = (docxCrcTable[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function syntheticDocx(documentTextXml: string): Buffer {
  const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const entries = [
    {
      name: '[Content_Types].xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${contentType}"/></Types>`
    },
    {
      name: '_rels/.rels',
      contents: '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    },
    {
      name: 'word/document.xml',
      contents: `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${wordNamespace}"><w:body>${documentTextXml}<w:sectPr/></w:body></w:document>`
    }
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const contents = Buffer.from(entry.contents);
    const compressed = deflateRawSync(contents);
    const checksum = docxCrc32(contents);
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
  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, end]);
}

async function docxFileForCli(documentTextXml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'local-pii-docx-cli-'));
  directories.push(root);
  const input = join(root, 'document.docx');
  await writeFile(input, syntheticDocx(documentTextXml));
  return input;
}

function capture(): { readonly io: CliIo; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) }, stdout, stderr };
}

describe('CLI TXT vertical slice', () => {
  it('returns the stable privacy-safe cancellation envelope without reading the input', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = capture();

    expect(await executeCli(['scan', '/private/path/never-read.txt', '--json'], stream.io, {
      signal: controller.signal
    })).toBe(130);
    expect(stream.stdout).toHaveLength(0);
    expect(JSON.parse(stream.stderr.join(''))).toEqual({
      schemaVersion: '3.0.0',
      error: {
        code: 'OPERATION_CANCELLED',
        message: 'The operation was cancelled.',
        retryable: false,
        correlationId: 'cor_cli_cancelled'
      }
    });
    expect(stream.stderr.join('')).not.toContain('/private/path/never-read.txt');
  });

  it('converts SIGINT and SIGTERM to cooperative cancellation and removes both listeners', async () => {
    const source = new EventEmitter();
    const signals = createProcessSignalController(source);
    expect(source.listenerCount('SIGINT')).toBe(1);
    expect(source.listenerCount('SIGTERM')).toBe(1);
    expect(signals.signal.aborted).toBe(false);

    source.emit('SIGINT');
    expect(signals.signal.aborted).toBe(true);
    expect(signals.exitCode).toBe(130);
    signals.dispose();
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);

    const terminationSource = new EventEmitter();
    const termination = createProcessSignalController(terminationSource);
    terminationSource.emit('SIGTERM');
    expect(termination.signal.aborted).toBe(true);
    expect(termination.exitCode).toBe(143);
    const terminated = capture();
    expect(await executeCli(['scan', '/private/path/never-read.txt', '--json'], terminated.io, {
      signal: termination.signal,
      getCancellationExitCode: () => termination.exitCode
    })).toBe(143);
    termination.dispose();
  });

  it('dry-runs and explicitly cleans only stale stages for the selected output', async () => {
    const { root, output } = await fixture();
    const selectedStage = join(root, '.source.redacted.11111111-1111-4111-8111-111111111111.staged.txt');
    const unrelatedStage = join(root, '.another.22222222-2222-4222-8222-222222222222.staged.txt');
    await Promise.all([writeFile(selectedStage, 'synthetic staged content'), writeFile(unrelatedStage, 'unrelated')]);
    const old = new Date('2000-01-01T00:00:00.000Z');
    await Promise.all([utimes(selectedStage, old, old), utimes(unrelatedStage, old, old)]);

    const dryRun = capture();
    expect(await executeCli(['cleanup-stages', '--output', output, '--json'], dryRun.io)).toBe(0);
    const dryReport = JSON.parse(dryRun.stdout.join('')) as {
      readonly operation: string;
      readonly mode: string;
      readonly staleStageFileCount: number;
      readonly deletedStageFileCount: number;
      readonly capped: boolean;
    };
    expect(dryReport).toMatchObject({
      operation: 'STAGE_RECOVERY',
      mode: 'DRY_RUN',
      staleStageFileCount: 1,
      deletedStageFileCount: 0,
      capped: false
    });
    expect(dryRun.stdout.join('')).not.toContain(root);
    expect(await readdir(root)).toContain('.source.redacted.11111111-1111-4111-8111-111111111111.staged.txt');

    let checks = 0;
    const signal = {
      get aborted(): boolean { return checks >= 5; },
      throwIfAborted(): void {
        checks += 1;
        if (checks >= 5) throw new DOMException('The operation was aborted.', 'AbortError');
      }
    } as unknown as AbortSignal;
    const cancelled = capture();
    expect(await executeCli(['cleanup-stages', '--output', output, '--apply', '--json'], cancelled.io, { signal })).toBe(130);
    const cancelledReport = JSON.parse(cancelled.stderr.join('')) as {
      readonly schemaVersion: string;
      readonly error: { readonly code: string };
    };
    expect(cancelledReport).toMatchObject({
      schemaVersion: '3.0.0',
      error: { code: 'OPERATION_CANCELLED' }
    });
    expect(await readFile(selectedStage, 'utf8')).toBe('synthetic staged content');

    const cleanup = capture();
    expect(await executeCli(['cleanup-stages', '--output', output, '--apply', '--json'], cleanup.io)).toBe(0);
    expect(JSON.parse(cleanup.stdout.join(''))).toMatchObject({
      operation: 'STAGE_RECOVERY',
      mode: 'APPLY',
      staleStageFileCount: 1,
      deletedStageFileCount: 1,
      deletionFailureCount: 0
    });
    expect(await readdir(root)).not.toContain('.source.redacted.11111111-1111-4111-8111-111111111111.staged.txt');
    expect(await readFile(unrelatedStage, 'utf8')).toBe('unrelated');
  });

  it('lists and explains bundled policies without accessing artifacts or Ollama', async () => {
    const fetchImplementation = vi.fn(() => {
      throw new Error('Policy inspection must not make network requests.');
    });
    vi.stubGlobal('fetch', fetchImplementation);
    try {
      const listed = capture();
      expect(await executeCli(['policies', 'list', '--json'], listed.io)).toBe(0);
      const listReport = JSON.parse(listed.stdout.join('')) as {
        readonly schemaVersion: string;
        readonly operation: string;
        readonly policies: readonly { readonly id: string; readonly riskTier: string; readonly example: boolean }[];
      };
      expect(listReport).toMatchObject({ schemaVersion: '1.0.0', operation: 'POLICY_LIST' });
      expect(listReport.policies).toEqual([
        expect.objectContaining({ id: 'development-labels', riskTier: 'LOW', example: true }),
        expect.objectContaining({ id: 'high-risk-disclosure', riskTier: 'HIGH', example: true })
      ]);
      expect(listed.stderr).toHaveLength(0);

      const development = capture();
      expect(await executeCli(['policies', 'explain', 'development-labels', '--json'], development.io)).toBe(0);
      const developmentReport = JSON.parse(development.stdout.join('')) as {
        readonly operation: string;
        readonly satisfiable: boolean;
        readonly capability: { readonly id: string; readonly engineMode: string };
        readonly decisions: readonly { readonly code: string; readonly available: boolean }[];
      };
      expect(developmentReport).toMatchObject({
        operation: 'POLICY_EXPLAIN',
        satisfiable: true,
        capability: { id: 'local-rules-files', engineMode: 'RULES_ONLY' }
      });
      expect(developmentReport.decisions.every(({ available }) => available)).toBe(true);

      const repeated = capture();
      expect(await executeCli(['policies', 'explain', 'development-labels', '--json'], repeated.io)).toBe(0);
      expect(repeated.stdout.join('')).toBe(development.stdout.join(''));

      const highRisk = capture();
      expect(await executeCli(['policies', 'explain', 'high-risk-disclosure', '--json'], highRisk.io)).toBe(0);
      const highRiskReport = JSON.parse(highRisk.stdout.join('')) as {
        readonly satisfiable: boolean;
        readonly decisions: readonly { readonly code: string; readonly available: boolean }[];
      };
      expect(highRiskReport.satisfiable).toBe(false);
      expect(highRiskReport.decisions).toContainEqual({
        code: 'FORMAT_QUALIFICATION_SUFFICIENT',
        available: false
      });
      expect(highRiskReport.decisions).toContainEqual({
        code: 'ENTITY_DETECTOR_REQUIREMENTS_SATISFIED',
        available: false
      });

      for (const output of [listed.stdout.join(''), development.stdout.join(''), highRisk.stdout.join('')]) {
        expect(output).not.toContain('/Users/');
        expect(output).not.toContain('/tmp/');
      }
      expect(fetchImplementation).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects malformed or inapplicable policy inspection arguments with the canonical usage error', async () => {
    const invalidArguments = [
      ['policies'],
      ['policies', 'list', 'development-labels'],
      ['policies', 'explain'],
      ['policies', 'explain', 'unknown-policy'],
      ['policies', 'list', '--engine', 'rules'],
      ['policies', 'list', '--output', 'report.json'],
      ['policies', 'list', '--allow-experimental'],
      ['policies', 'list', '--help'],
      ['policies', 'list', '--license']
    ];
    for (const argv of invalidArguments) {
      const stream = capture();
      expect(await executeCli([...argv, '--json'], stream.io), argv.join(' ')).toBe(2);
      expect(stream.stdout).toHaveLength(0);
      expect(JSON.parse(stream.stderr.join(''))).toMatchObject({
        schemaVersion: '1.0.0',
        error: { code: 'SCHEMA_INVALID', correlationId: 'cor_cli_usage' }
      });
    }
  });

  it('publishes a canonical rules-only capability manifest', async () => {
    const stream = capture();
    expect(await executeCli(['capabilities', '--json'], stream.io)).toBe(0);
    const manifest = JSON.parse(stream.stdout.join('')) as {
      readonly engineMode: string;
      readonly formats: readonly { readonly id: string; readonly mediaTypes: readonly string[]; readonly qualification: string }[];
      readonly detectors: readonly { readonly id: string }[];
    };
    expect(manifest.engineMode).toBe('RULES_ONLY');
    expect(manifest.formats).toContainEqual(expect.objectContaining({ id: 'text', qualification: 'DEVELOPMENT' }));
    expect(manifest.formats).toContainEqual(expect.objectContaining({
      id: 'json',
      mediaTypes: ['application/json'],
      qualification: 'DEVELOPMENT'
    }));
    expect(manifest.formats).toContainEqual(expect.objectContaining({
      id: 'csv',
      mediaTypes: ['text/csv'],
      qualification: 'DEVELOPMENT'
    }));
    expect(manifest.formats).toContainEqual(expect.objectContaining({
      id: 'docx',
      mediaTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      operations: ['PROBE', 'INSPECT', 'EXTRACT', 'SCAN'],
      qualification: 'EXPERIMENTAL'
    }));
    expect(manifest.detectors.map(({ id }) => id)).toEqual([
      'email-pattern',
      'phone-pattern',
      'ssn-structure',
      'payment-card-luhn',
      'ip-parser',
      'secret-assignment'
    ]);
    expect(stream.stderr).toHaveLength(0);

    const invalid = capture();
    expect(await executeCli(['capabilities', 'unexpected-input', '--json'], invalid.io)).toBe(2);
    expect(invalid.stdout).toHaveLength(0);
    expect(JSON.parse(invalid.stderr.join(''))).toMatchObject({
      schemaVersion: '1.0.0',
      error: { code: 'SCHEMA_INVALID', retryable: false, correlationId: 'cor_cli_usage' }
    });
  });

  it('uses the canonical error envelope for malformed JSON-mode arguments', async () => {
    const stream = capture();
    expect(await executeCli(['redact', 'sample.txt', '--output', '--json'], stream.io)).toBe(2);
    expect(stream.stdout).toHaveLength(0);
    const report = JSON.parse(stream.stderr.join('')) as {
      readonly schemaVersion: string;
      readonly error: { readonly code: string };
    };
    expect(report).toMatchObject({
      schemaVersion: '1.0.0',
      error: { code: 'SCHEMA_INVALID', message: 'The command arguments are invalid.' }
    });

    const experimental = capture();
    expect(await executeCli(['scan', 'sample.txt', '--engine', 'ollama', '--model', 'phi4-mini', '--json'], experimental.io)).toBe(2);
    expect(JSON.parse(experimental.stderr.join(''))).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });

    const remoteEndpoint = capture();
    expect(await executeCli([
      'scan', 'sample.txt', '--engine', 'ollama', '--model', 'phi4-mini',
      '--allow-experimental', '--ollama-url', 'http://example.test:11434', '--json'
    ], remoteEndpoint.io)).toBe(2);
    expect(JSON.parse(remoteEndpoint.stderr.join(''))).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });

    for (const argv of [
      ['scan', 'sample.txt', '--policy', 'development-labels'],
      ['verify', 'sample.txt', '--policy', 'development-labels'],
      ['inspect', 'sample.txt', '--policy', 'development-labels'],
      ['redact', 'sample.txt', '--policy', 'unknown-policy'],
      ['redact', 'sample.txt', '--policy', 'development-labels', '--policy', 'development-labels'],
      ['redact', 'sample.txt', '--output', 'first.txt', '--output', 'second.txt'],
      ['redact', 'sample.txt', '--engine', 'ollama', '--model', 'phi4-mini', '--allow-experimental', '--policy', 'development-labels']
    ]) {
      const invalidPolicy = capture();
      expect(await executeCli([...argv, '--json'], invalidPolicy.io), argv.join(' ')).toBe(2);
      expect(JSON.parse(invalidPolicy.stderr.join(''))).toMatchObject({ error: { code: 'SCHEMA_INVALID' } });
    }
  });

  it('requires an explicit redaction output before reading input or creating files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-cli-'));
    directories.push(root);
    const stream = capture();
    const missingInput = join(root, 'must-not-be-read.txt');

    expect(await executeCli(['redact', missingInput, '--json'], stream.io)).toBe(2);
    expect(stream.stdout).toHaveLength(0);
    const usageReport = JSON.parse(stream.stderr.join('')) as {
      readonly schemaVersion: string;
      readonly error: { readonly code: string };
    };
    expect(usageReport).toMatchObject({
      schemaVersion: '1.0.0',
      error: { code: 'SCHEMA_INVALID' }
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('runs an explicitly experimental hybrid scan against a pinned local Ollama model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-hybrid-'));
    directories.push(root);
    const input = join(root, 'context.txt');
    const text = '😀 Synthetic record. The birth date is 1991-07-14.';
    const value = '1991-07-14';
    await writeFile(input, text);

    let requests = 0;
    const server = createServer((request, response) => {
      requests += 1;
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        response.end(JSON.stringify({ models: [{ name: 'phi4-mini:latest', digest: 'a'.repeat(64) }] }));
        return;
      }
      request.resume();
      request.once('end', () => {
        response.end(JSON.stringify({
          model: 'phi4-mini:latest',
          message: {
            role: 'assistant',
            content: JSON.stringify({ detections: [{ entityType: 'DATE_OF_BIRTH', verbatim: value }] })
          },
          done: true
        }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected local test server address.');
    const endpoint = `http://127.0.0.1:${String(address.port)}`;

    try {
      const rules = capture();
      expect(await executeCli(['scan', input, '--json'], rules.io)).toBe(0);
      expect(rules.stdout.join('')).not.toContain('DATE_OF_BIRTH');
      expect(rules.stdout.join('')).not.toContain('PHONE');
      expect(requests).toBe(0);

      const hybrid = capture();
      const hybridExit = await executeCli([
        'scan', input, '--engine', 'ollama', '--model', 'phi4-mini', '--allow-experimental',
        '--ollama-url', endpoint, '--timeout-ms', '5000', '--json'
      ], hybrid.io);
      expect(hybridExit, hybrid.stderr.join('')).toBe(0);
      const report = JSON.parse(hybrid.stdout.join('')) as {
        readonly detectorBundleVersion: string;
        readonly counts: { readonly byEntity: Readonly<Record<string, number>> };
        readonly detections: readonly { readonly confidence: number }[];
      };
      expect(report.counts.byEntity.DATE_OF_BIRTH).toBe(1);
      expect(report.detections).toContainEqual(expect.objectContaining({ confidence: 0.5 }));
      expect(report.detectorBundleVersion).toMatch(/^composite-v1-/u);
      expect(hybrid.stderr.join('')).toContain('EXPERIMENTAL');
      expect(hybrid.stdout.join('')).not.toContain(value);
      expect(hybrid.stderr.join('')).not.toContain(value);
      expect(requests).toBe(3);

      const capabilities = capture();
      expect(await executeCli([
        'capabilities', '--engine', 'ollama', '--model', 'phi4-mini', '--allow-experimental',
        '--ollama-url', endpoint, '--json'
      ], capabilities.io)).toBe(0);
      const capabilityReport = JSON.parse(capabilities.stdout.join('')) as {
        readonly engineMode: string;
        readonly detectors: readonly { readonly id: string; readonly version: string; readonly availability: string; readonly qualification: string }[];
      };
      expect(capabilityReport.engineMode).toBe('LOCAL_HYBRID');
      expect(capabilityReport.detectors).toContainEqual(
        expect.objectContaining({
          id: 'ollama-local-model',
          version: `0.1.0-ollama-experimental.2.sha256-${'a'.repeat(64)}`,
          availability: 'AVAILABLE',
          qualification: 'EXPERIMENTAL'
        })
      );
      expect(requests).toBe(4);

      const humanCapabilities = capture();
      expect(await executeCli([
        'capabilities', '--engine', 'ollama', '--model', 'phi4-mini', '--allow-experimental',
        '--ollama-url', endpoint
      ], humanCapabilities.io)).toBe(0);
      expect(humanCapabilities.stdout.join('')).toContain('Engine mode: LOCAL_HYBRID');
      expect(humanCapabilities.stderr.join('')).toContain('EXPERIMENTAL');
      expect(requests).toBe(5);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('fails closed without exposing an unanchored model value in the machine error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-hybrid-invalid-'));
    directories.push(root);
    const input = join(root, 'context.txt');
    const sourceCanary = 'synthetic source content';
    const responseCanary = 'model-response-value-canary';
    await writeFile(input, sourceCanary);

    const server = createServer((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tags') {
        response.end(JSON.stringify({ models: [{ name: 'phi4-mini:latest', digest: 'a'.repeat(64) }] }));
        return;
      }
      request.resume();
      request.once('end', () => {
        response.end(JSON.stringify({
          model: 'phi4-mini:latest',
          message: {
            role: 'assistant',
            content: JSON.stringify({ detections: [{ entityType: 'PERSON', verbatim: responseCanary }] })
          },
          done: true
        }));
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('Expected local test server address.');

    try {
      const stream = capture();
      expect(await executeCli([
        'scan', input, '--engine', 'ollama', '--model', 'phi4-mini', '--allow-experimental',
        '--ollama-url', `http://127.0.0.1:${String(address.port)}`, '--json'
      ], stream.io)).toBe(3);
      expect(stream.stdout).toHaveLength(0);
      expect(JSON.parse(stream.stderr.join(''))).toMatchObject({ error: { code: 'MODEL_OUTPUT_INVALID' } });
      expect(stream.stderr.join('')).not.toContain(sourceCanary);
      expect(stream.stderr.join('')).not.toContain(responseCanary);
    } finally {
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
    }
  });

  it('matches the tracked sample-data golden output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-golden-'));
    directories.push(root);
    const input = join(root, 'sample.txt');
    const output = join(root, 'sample.redacted.txt');
    const fixtureRoot = join(import.meta.dirname, '../../../sample-data');
    await copyFile(join(fixtureRoot, 'input/sample.txt'), input);
    const stream = capture();
    expect(await executeCli(['redact', input, '--output', output, '--json'], stream.io)).toBe(0);
    expect(await readFile(output, 'utf8')).toBe(await readFile(join(fixtureRoot, 'expected/sample.redacted.txt'), 'utf8'));
  });

  it('scans without serializing matched values', async () => {
    const { input } = await fixture();
    const stream = capture();
    expect(await executeCli(['scan', input, '--json'], stream.io)).toBe(0);
    const output = stream.stdout.join('');
    expect(output).toContain('"entityType": "EMAIL"');
    expect(output).not.toContain('alpha@example.test');
    expect(stream.stderr).toHaveLength(0);
  });

  it('writes a separate typed-label output and gates it through reopen/rescan verification', async () => {
    const { input, output } = await fixture();
    const original = await readFile(input, 'utf8');
    const stream = capture();
    expect(await executeCli(['redact', input, '--output', output, '--json'], stream.io)).toBe(0);
    const redacted = await readFile(output, 'utf8');
    expect(redacted).toContain('[EMAIL_1]');
    expect(redacted).toContain('[SSN_1]');
    expect(redacted).toContain('[CREDIT_CARD_1]');
    expect(redacted).toContain('[IP_ADDRESS_1]');
    expect(redacted).toContain('[API_KEY_1]');
    expect(redacted).not.toContain('alpha@example.test');
    expect(await readFile(input, 'utf8')).toBe(original);
    const report = JSON.parse(stream.stdout.join('')) as {
      readonly outcome: string;
      readonly schemaVersion: string;
      readonly input: { readonly digest: string };
      readonly policy: { readonly id: string; readonly version: string; readonly digest: string };
      readonly plan: {
        readonly id: string;
        readonly digest: string;
        readonly inputDigest: string;
        readonly extractionRevision: string;
        readonly resolutionDigest: string;
        readonly capabilityDigest: string;
        readonly policyDigest: string;
        readonly detectorBundleVersion: string;
        readonly writer: { readonly id: string; readonly version: string };
        readonly strategyVersion: string;
      };
      readonly writerReceipt: {
        readonly receiptDigest: string;
        readonly planDigest: string;
        readonly outputDigest: string;
        readonly writer: { readonly id: string; readonly version: string };
        readonly expectedActionCount: number;
        readonly appliedActionCount: number;
      };
      readonly output: { readonly digest: string };
      readonly verification: {
        readonly schemaVersion: string;
        readonly input: { readonly digest: string };
        readonly output: { readonly digest: string };
        readonly plan: { readonly id: string; readonly digest: string };
        readonly policy: { readonly id: string; readonly digest: string };
        readonly capabilityDigest: string;
        readonly writerReceiptDigest: string;
        readonly profile: { readonly id: string; readonly version: string; readonly digest: string };
        readonly verifier: { readonly id: string; readonly version: string; readonly digest: string };
        readonly detectorBundle: { readonly id: string; readonly version: string; readonly digest: string };
        readonly writer: { readonly id: string; readonly version: string; readonly digest: string };
        readonly application: { readonly id: string; readonly version: string; readonly digest: string };
        readonly outcome: string;
        readonly reconciliation: {
          readonly expectedActionCount: number;
          readonly appliedActionCount: number;
          readonly missingActionCount: number;
          readonly unexpectedActionCount: number;
          readonly duplicateActionCount: number;
        };
        readonly reportDigest: string;
      };
    };
    expect(report).toMatchObject({ schemaVersion: '2.0.0', outcome: 'VERIFIED' });
    expect(report.policy).toMatchObject({ id: 'development-labels', version: '0.1.0' });
    expect(report.plan.policyDigest).toBe(report.policy.digest);
    expect(report.plan.inputDigest).toBe(report.input.digest);
    expect(report.plan.extractionRevision).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.plan.id).toMatch(/^plan_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(report.plan.resolutionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.plan.capabilityDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.plan.detectorBundleVersion).toBe('0.1.0');
    expect(report.plan.writer).toEqual({ id: 'text-adapter', version: '0.1.0' });
    expect(report.plan.strategyVersion).toBe('0.1.0');
    expect(report.writerReceipt).toMatchObject({
      planDigest: report.plan.digest,
      outputDigest: report.output.digest,
      writer: report.plan.writer,
      expectedActionCount: 5,
      appliedActionCount: 5
    });
    expect(report.writerReceipt.receiptDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(report.verification).toMatchObject({
      schemaVersion: '2.0.0',
      input: { digest: report.input.digest },
      output: { digest: report.output.digest },
      plan: { id: report.plan.id, digest: report.plan.digest },
      policy: { id: report.policy.id, digest: report.policy.digest },
      capabilityDigest: report.plan.capabilityDigest,
      writerReceiptDigest: report.writerReceipt.receiptDigest,
      profile: { id: 'text-rescan-v1', version: '0.1.0' },
      verifier: { id: 'text-verifier', version: '0.1.0' },
      detectorBundle: { id: 'deterministic-text', version: '0.1.0' },
      writer: { id: 'text-adapter', version: '0.1.0' },
      application: { id: 'local-pii-cli', version: '0.1.0' },
      outcome: 'PASS',
      reconciliation: {
        expectedActionCount: 5,
        appliedActionCount: 5,
        missingActionCount: 0,
        unexpectedActionCount: 0,
        duplicateActionCount: 0
      }
    });
    expect(report.verification.reportDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    for (const component of [
      report.verification.profile,
      report.verification.verifier,
      report.verification.detectorBundle,
      report.verification.writer,
      report.verification.application
    ]) {
      expect(component.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
    expect(stream.stdout.join('')).not.toContain('appliedActionIds');
    expect(stream.stdout.join('')).not.toContain('actionIds');
    expect(stream.stdout.join('')).not.toContain(input);
    expect(stream.stdout.join('')).not.toContain(output);
  });

  it('fails a high-risk policy before reading a missing input or creating output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-policy-'));
    directories.push(root);
    const input = join(root, 'does-not-exist.txt');
    const output = join(root, 'must-not-exist.txt');
    const stream = capture();
    expect(await executeCli([
      'redact', input, '--policy', 'high-risk-disclosure', '--output', output, '--json'
    ], stream.io)).toBe(3);
    expect(JSON.parse(stream.stderr.join(''))).toMatchObject({
      error: { code: 'POLICY_UNSATISFIABLE', correlationId: 'cor_cli_redact' }
    });
    await expect(readFile(output, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails verification on an unredacted input and refuses to overwrite output', async () => {
    const { input, output } = await fixture();
    const verify = capture();
    expect(await executeCli(['verify', input, '--json'], verify.io)).toBe(4);
    expect(verify.stdout.join('')).not.toContain('alpha@example.test');

    await writeFile(output, 'existing');
    const redact = capture();
    expect(await executeCli(['redact', input, '--output', output, '--json'], redact.io)).toBe(6);
    expect(await readFile(output, 'utf8')).toBe('existing');
  });

  it('does not expose a user-controlled filename in standalone residual-scan JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-verify-name-'));
    directories.push(root);
    const filenameCanary = 'filename-canary-alpha@example.test.txt';
    const input = join(root, filenameCanary);
    await writeFile(input, 'Contact [EMAIL_1]');
    const stream = capture();
    expect(await executeCli(['verify', input, '--json'], stream.io)).toBe(0);
    expect(stream.stdout.join('')).not.toContain(filenameCanary);
    expect(stream.stdout.join('')).not.toContain(root);
  });

  it('scans, natively redacts, reopens, and verifies JSON string values without changing keys or input metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-json-cli-'));
    directories.push(root);
    const input = join(root, 'records.json');
    const output = join(root, 'records.redacted.json');
    const raw = [
      '{',
      '  "key-canary@example.test": "alpha@example.test",',
      '  "profile": { "ssn": "123-45-6789", "safe": 42 },',
      '  "contacts": [true, null, "+1 202-555-0147"],',
      '  "split": ["bridge@", "example.test"]',
      '}',
      ''
    ].join('\n');
    await writeFile(input, raw);
    const before = await stat(input, { bigint: true });

    const scan = capture();
    expect(await executeCli(['scan', input, '--json'], scan.io), scan.stderr.join('')).toBe(0);
    const scanReport = JSON.parse(scan.stdout.join('')) as {
      readonly input: { readonly mediaType: string };
      readonly counts: { readonly detections: number; readonly byEntity: Readonly<Record<string, number>> };
    };
    expect(scanReport.input.mediaType).toBe('application/json');
    expect(scanReport.counts.detections).toBe(3);
    expect(scanReport.counts.byEntity).toMatchObject({ EMAIL: 1, SSN: 1, PHONE: 1 });
    expect(scan.stdout.join('')).not.toContain('alpha@example.test');
    expect(scan.stdout.join('')).not.toContain('key-canary@example.test');

    const wrongOutput = join(root, 'records.redacted.txt');
    const wrongExtension = capture();
    expect(await executeCli(['redact', input, '--output', wrongOutput, '--json'], wrongExtension.io)).toBe(3);
    expect(JSON.parse(wrongExtension.stderr.join(''))).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED' } });
    expect(await readdir(root)).toEqual(['records.json']);

    const redact = capture();
    expect(await executeCli(['redact', input, '--output', output, '--json'], redact.io), redact.stderr.join('')).toBe(0);
    const transformed = await readFile(output, 'utf8');
    expect(transformed).toBe([
      '{',
      '  "key-canary@example.test": "[EMAIL_1]",',
      '  "profile": { "ssn": "[SSN_1]", "safe": 42 },',
      '  "contacts": [true, null, "[PHONE_1]"],',
      '  "split": ["bridge@", "example.test"]',
      '}',
      ''
    ].join('\n'));
    expect(JSON.parse(transformed)).toEqual({
      'key-canary@example.test': '[EMAIL_1]',
      profile: { ssn: '[SSN_1]', safe: 42 },
      contacts: [true, null, '[PHONE_1]'],
      split: ['bridge@', 'example.test']
    });
    expect(await readFile(input, 'utf8')).toBe(raw);
    const after = await stat(input, { bigint: true });
    expect({ mode: after.mode, size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs }).toEqual({
      mode: before.mode,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs
    });
    expect((JSON.parse(redact.stdout.join('')) as { readonly plan: { readonly writer: { readonly id: string } } }).plan.writer.id).toBe('json-adapter');

    const verify = capture();
    expect(await executeCli(['verify', output, '--json'], verify.io)).toBe(0);
    expect(JSON.parse(verify.stdout.join(''))).toMatchObject({ operation: 'VERIFY', outcome: 'PASS' });

    const inspect = capture();
    expect(await executeCli(['inspect', input, '--json'], inspect.io)).toBe(0);
    expect(JSON.parse(inspect.stdout.join(''))).toMatchObject({
      artifact: { mediaType: 'application/json' },
      capability: { adapter: 'json' }
    });
  });

  it('rejects experimental Ollama for JSON before making a provider request', async () => {
    const path = await jsonFileForCli('{"value":"alpha@example.test"}');
    const fetchImplementation = vi.fn(() => {
      throw new Error('JSON hybrid rejection must happen before a network request.');
    });
    vi.stubGlobal('fetch', fetchImplementation);
    try {
      const stream = capture();
      expect(await executeCli([
        'scan', path, '--engine', 'ollama', '--model', 'phi4-mini', '--allow-experimental', '--json'
      ], stream.io)).toBe(3);
      expect(fetchImplementation).not.toHaveBeenCalled();
      expect(JSON.parse(stream.stderr.join(''))).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('scans, natively redacts, reopens, and verifies CSV cells without normalizing untouched fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'local-pii-csv-cli-'));
    directories.push(root);
    const input = join(root, 'records.csv');
    const output = join(root, 'records.redacted.csv');
    const raw = [
      'name,email,note',
      'Alice,alpha@example.test,"keep, exactly"',
      'Bob,"+1 202-555-0147","quote ""stays"""',
      'Casey,123-45-6789,safe',
      ''
    ].join('\r\n');
    await writeFile(input, raw);
    const before = await stat(input, { bigint: true });

    const scan = capture();
    expect(await executeCli(['scan', input, '--json'], scan.io), scan.stderr.join('')).toBe(0);
    expect(JSON.parse(scan.stdout.join(''))).toMatchObject({
      input: { mediaType: 'text/csv' },
      counts: { detections: 3, byEntity: { EMAIL: 1, PHONE: 1, SSN: 1 } }
    });
    expect(scan.stdout.join('')).not.toContain('alpha@example.test');

    const wrong = capture();
    expect(await executeCli(['redact', input, '--output', join(root, 'records.txt'), '--json'], wrong.io)).toBe(3);
    expect(JSON.parse(wrong.stderr.join(''))).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED' } });
    expect(await readdir(root)).toEqual(['records.csv']);

    const redact = capture();
    expect(await executeCli(['redact', input, '--output', output, '--json'], redact.io), redact.stderr.join('')).toBe(0);
    expect(await readFile(output, 'utf8')).toBe([
      'name,email,note',
      'Alice,[EMAIL_1],"keep, exactly"',
      'Bob,"[PHONE_1]","quote ""stays"""',
      'Casey,[SSN_1],safe',
      ''
    ].join('\r\n'));
    expect((JSON.parse(redact.stdout.join('')) as { readonly plan: { readonly writer: { readonly id: string } } }).plan.writer.id).toBe('csv-adapter');
    expect(await readFile(input, 'utf8')).toBe(raw);
    const after = await stat(input, { bigint: true });
    expect({ mode: after.mode, size: after.size, mtimeNs: after.mtimeNs, ctimeNs: after.ctimeNs }).toEqual({
      mode: before.mode,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs
    });

    const verify = capture();
    expect(await executeCli(['verify', output, '--json'], verify.io)).toBe(0);
    const inspect = capture();
    expect(await executeCli(['inspect', input, '--json'], inspect.io)).toBe(0);
    expect(JSON.parse(inspect.stdout.join(''))).toMatchObject({
      artifact: { mediaType: 'text/csv' },
      capability: { adapter: 'csv' }
    });
  });

  it('rejects experimental Ollama for CSV before making a provider request', async () => {
    const path = await csvFileForCli('value\nalpha@example.test\n');
    const fetchImplementation = vi.fn(() => {
      throw new Error('CSV hybrid rejection must happen before a network request.');
    });
    vi.stubGlobal('fetch', fetchImplementation);
    try {
      const stream = capture();
      expect(await executeCli([
        'scan', path, '--engine', 'ollama', '--model', 'phi4-mini', '--allow-experimental', '--json'
      ], stream.io)).toBe(3);
      expect(fetchImplementation).not.toHaveBeenCalled();
      expect(JSON.parse(stream.stderr.join(''))).toMatchObject({ error: { code: 'FORMAT_UNSUPPORTED' } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('inspects and scans the strict experimental DOCX surface without exposing source values', async () => {
    const path = await docxFileForCli(
      '<w:p><w:r><w:t>Contact alpha@</w:t></w:r><w:r><w:t>example.test.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>SSN 123-45-6789.</w:t></w:r></w:p>'
    );

    const inspect = capture();
    expect(await executeCli(['inspect', path, '--json'], inspect.io), inspect.stderr.join('')).toBe(0);
    expect(JSON.parse(inspect.stdout.join(''))).toMatchObject({
      artifact: { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      capability: { adapter: 'docx', operations: ['INSPECT', 'SCAN'] }
    });

    const scan = capture();
    expect(await executeCli(['scan', path, '--json'], scan.io), scan.stderr.join('')).toBe(0);
    expect(JSON.parse(scan.stdout.join(''))).toMatchObject({
      input: { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      counts: { detections: 2, byEntity: { EMAIL: 1, SSN: 1 } }
    });
    for (const output of [inspect.stdout.join(''), scan.stdout.join(''), scan.stderr.join('')]) {
      expect(output).not.toContain('alpha@example.test');
      expect(output).not.toContain('123-45-6789');
      expect(output).not.toContain(path);
    }
  });

  it('fails closed for DOCX redaction, verification, and experimental Ollama before publication or network access', async () => {
    const path = await docxFileForCli('<w:p><w:r><w:t>alpha@example.test</w:t></w:r></w:p>');
    const output = join(path.slice(0, -'.docx'.length), '.redacted.docx');
    const fetchImplementation = vi.fn(() => {
      throw new Error('DOCX hybrid rejection must happen before a network request.');
    });
    vi.stubGlobal('fetch', fetchImplementation);
    try {
      for (const argv of [
        ['redact', path, '--output', output, '--json'],
        ['verify', path, '--json'],
        ['scan', path, '--engine', 'ollama', '--model', 'phi4-mini', '--allow-experimental', '--json']
      ]) {
        const stream = capture();
        expect(await executeCli(argv, stream.io), argv.join(' ')).toBe(3);
        const failure = JSON.parse(stream.stderr.join('')) as { readonly error: { readonly code: string } };
        expect(['FORMAT_UNSUPPORTED', 'POLICY_UNSATISFIABLE'], argv.join(' ')).toContain(failure.error.code);
      }
      expect(fetchImplementation).not.toHaveBeenCalled();
      await expect(stat(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
