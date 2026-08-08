import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { executeCli, type CliIo } from '../src/commands.js';

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
    expect(await executeCli(['capabilities', 'unexpected-input'], invalid.io)).toBe(2);
    expect(invalid.stdout).toHaveLength(0);
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
    expect(stream.stdout.join('')).toContain('"outcome": "VERIFIED"');
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
});
