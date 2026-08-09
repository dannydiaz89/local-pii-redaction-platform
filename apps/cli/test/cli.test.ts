import { copyFile, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        capability: { id: 'local-rules-text', engineMode: 'RULES_ONLY' }
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
      readonly formats: readonly { readonly id: string; readonly qualification: string }[];
      readonly detectors: readonly { readonly id: string }[];
    };
    expect(manifest.engineMode).toBe('RULES_ONLY');
    expect(manifest.formats).toContainEqual(expect.objectContaining({ id: 'text', qualification: 'DEVELOPMENT' }));
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
    const start = Array.from(text.slice(0, text.indexOf(value))).length;
    const end = start + Array.from(value).length;
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
            content: JSON.stringify({ detections: [{ entityType: 'DATE_OF_BIRTH', start, end, confidence: 0.9 }] })
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
      };
      expect(report.counts.byEntity.DATE_OF_BIRTH).toBe(1);
      expect(report.detectorBundleVersion).toMatch(/^composite-v1-/u);
      expect(hybrid.stderr.join('')).toContain('EXPERIMENTAL');
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
          version: `0.1.0-ollama-experimental.1.sha256-${'a'.repeat(64)}`,
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
});
