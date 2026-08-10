import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createLocalWebAssets,
  createVolatileJobControl,
  browserLaunchCommand,
  loadLocalWebAssets,
  localWebContentSecurityPolicy,
  runTrustedLocalLauncher,
  startLocalWebApplication,
  type ApiDependencies,
  type CapabilityManifest,
  type RunningLocalWebApplication
} from '../src/index.js';

const bootstrapMarker = '<meta name="local-pii-bootstrap" content="pending" />';
const syntheticIndex = `<!doctype html><html><head>${bootstrapMarker}<link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"></div><script type="module" src="/assets/app.js"></script></body></html>`;
const repositoryRoot = resolve(import.meta.dirname, '../../..');
const runningApplications: RunningLocalWebApplication[] = [];
const temporaryDirectories: string[] = [];

function manifest(): CapabilityManifest {
  return JSON.parse(readFileSync(
    resolve(repositoryRoot, 'fixtures/contracts/valid/capability-rules-only-text.json'),
    'utf8'
  )) as CapabilityManifest;
}

function dependencies(): ApiDependencies {
  return {
    application: { getCapabilities: () => Promise.resolve(manifest()) },
    jobs: createVolatileJobControl(),
    policies: {
      get: () => Promise.resolve({
        schemaVersion: '1.0.0',
        defaultPolicyId: 'development-labels',
        policies: [{
          id: 'development-labels', version: '0.1.0', digest: `sha256:${'b'.repeat(64)}`,
          riskTier: 'LOW', example: true
        }]
      })
    },
    preview: {
      scan: () => Promise.resolve({
        schemaVersion: '2.0.0', operation: 'SCAN', outcome: 'SUCCEEDED',
        counts: { detections: 0, conflicts: 0, byEntity: {} },
        detections: [], detailsLimited: false, conflicts: [], conflictDetailsLimited: false
      })
    },
    readiness: { check: () => Promise.resolve() }
  };
}

function assets() {
  return createLocalWebAssets(syntheticIndex, [
    { name: 'app.css', mediaType: 'text/css', bytes: Buffer.from('body{color:#123}', 'utf8') },
    { name: 'app.js', mediaType: 'text/javascript', bytes: Buffer.from('document.body.dataset.ready="true";', 'utf8') }
  ]);
}

afterEach(async () => {
  await Promise.all(runningApplications.splice(0).map(async (running) => running.close()));
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

describe('trusted local web launcher', () => {
  it('hands a non-secret loopback URL to bounded macOS and Linux browser launchers without a shell', () => {
    const launchUrl = 'http://127.0.0.1:4174/.local-pii/launch';
    expect(browserLaunchCommand('darwin', launchUrl)).toEqual({
      executable: '/usr/bin/open', arguments: [launchUrl]
    });
    expect(browserLaunchCommand('linux', launchUrl)).toEqual({
      executable: '/usr/bin/xdg-open', arguments: [launchUrl]
    });
    expect(() => browserLaunchCommand('win32', launchUrl)).toThrow(TypeError);
  });

  it('performs a one-time bootstrap and serves authenticated capabilities from the same origin', async () => {
    const running = await startLocalWebApplication(dependencies(), { webAssets: assets() });
    runningApplications.push(running);
    const hostile = await fetch(running.launchUrl, { headers: { origin: 'http://127.0.0.1:4999' } });
    expect(hostile.status).toBe(403);

    const launch = await fetch(running.launchUrl);
    expect(launch.status).toBe(200);
    expect(launch.headers.get('content-security-policy')).toBe(localWebContentSecurityPolicy);
    expect(launch.headers.get('x-frame-options')).toBe('DENY');
    expect(launch.headers.get('cache-control')).toBe('no-store');
    const launchBody = await launch.text();
    const bootstrapPath = /src="(\/\.local-pii\/bootstrap\/[A-Za-z0-9_-]{43}\.js)"/u.exec(launchBody)?.[1];
    expect(bootstrapPath).toBeDefined();
    expect(launchBody).not.toContain('bearerToken');

    const bootstrap = await fetch(new URL(bootstrapPath as string, running.url));
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get('content-type')).toContain('text/javascript');
    const bootstrapBody = await bootstrap.text();
    const bearerToken = /bearerToken:"([A-Za-z0-9_-]{43})"/u.exec(bootstrapBody)?.[1];
    expect(bearerToken).toBeDefined();
    expect(bootstrapBody).toContain('window.location.origin');
    expect(bootstrapBody).toContain('history.replaceState');

    const capabilities = await fetch(`${running.url}/v1/capabilities`, {
      headers: { authorization: `Bearer ${bearerToken as string}`, origin: running.url }
    });
    expect(capabilities.status).toBe(200);
    expect((await capabilities.json()) as unknown).toEqual(manifest());

    const repeatedBootstrap = await fetch(new URL(bootstrapPath as string, running.url));
    expect(repeatedBootstrap.status).toBe(404);
    expect(await repeatedBootstrap.text()).not.toContain(bearerToken as string);
    expect((await fetch(running.launchUrl)).status).toBe(404);
  });

  it('loads only a bounded regular-file web build with an explicit bootstrap marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-pii-web-shell-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), syntheticIndex, { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(directory, 'assets', 'app.css'), 'body{color:#123}', { encoding: 'utf8', mode: 0o600 });
    await writeFile(join(directory, 'assets', 'app.js'), 'document.body.dataset.ready="true";', { encoding: 'utf8', mode: 0o600 });

    const loaded = await loadLocalWebAssets(directory);
    expect(loaded.indexHtml).toBe(syntheticIndex);
    expect(loaded.assets.map(({ name }) => name).sort()).toEqual(['app.css', 'app.js']);
  });

  it('rejects an asset directory before reading more than the bounded file count', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-pii-web-shell-count-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), syntheticIndex, { encoding: 'utf8', mode: 0o600 });
    for (let index = 0; index < 65; index += 1) {
      await writeFile(join(directory, 'assets', `asset-${String(index)}.js`), '0', { encoding: 'utf8', mode: 0o600 });
    }

    await expect(loadLocalWebAssets(directory)).rejects.toThrow('The local web asset directory is invalid.');
  });

  it('bounds aggregate asset reads before materializing an oversized build', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'local-pii-web-shell-bytes-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'assets'));
    await writeFile(join(directory, 'index.html'), syntheticIndex, { encoding: 'utf8', mode: 0o600 });
    const largeSyntheticAsset = Buffer.alloc(900 * 1024, 0x61);
    for (let index = 0; index < 5; index += 1) {
      await writeFile(join(directory, 'assets', `asset-${String(index)}.js`), largeSyntheticAsset, { mode: 0o600 });
    }

    await expect(loadLocalWebAssets(directory)).rejects.toThrow('A local web asset is invalid.');
  });

  it('closes the loopback server when the launcher lifecycle is cancelled', async () => {
    const lifecycle = new AbortController();
    let launchedUrl: string | undefined;
    await runTrustedLocalLauncher(dependencies(), { webAssets: assets() }, lifecycle.signal, (launchUrl) => {
      launchedUrl = launchUrl;
      lifecycle.abort();
      return Promise.resolve();
    });
    expect(launchedUrl).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+\/\.local-pii\/launch$/u);
    const origin = new URL(launchedUrl as string).origin;
    await expect(fetch(`${origin}/health/live`)).rejects.toThrow();
  });

  it('closes promptly when cancellation interrupts a non-cooperative browser opener', async () => {
    const lifecycle = new AbortController();
    let openerInvoked = false;
    const running = runTrustedLocalLauncher(
      dependencies(),
      { webAssets: assets() },
      lifecycle.signal,
      () => {
        openerInvoked = true;
        return new Promise<void>(() => undefined);
      },
      1_000
    );
    lifecycle.abort();
    await expect(running).resolves.toBeUndefined();
    expect(openerInvoked).toBe(false);
  });
});
