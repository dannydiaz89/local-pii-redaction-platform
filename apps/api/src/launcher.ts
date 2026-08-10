import { spawn } from 'node:child_process';

import type { ApiDependencies } from './application.js';
import {
  startLocalWebApplication,
  type StartLocalWebApplicationOptions
} from './server.js';

export interface BrowserLaunchCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
}

const launchUrlPattern = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}\/\.local-pii\/launch$/u;
export const browserOpenTimeoutMs = 5_000;

export function browserLaunchCommand(platform: NodeJS.Platform, launchUrl: string): BrowserLaunchCommand {
  let parsed: URL;
  try {
    parsed = new URL(launchUrl);
  } catch {
    throw new TypeError('The local browser launch URL is invalid.');
  }
  const port = Number(parsed.port);
  if (
    !launchUrlPattern.test(launchUrl)
    || parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || !Number.isSafeInteger(port)
    || port < 1
    || port > 65_535
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) throw new TypeError('The local browser launch URL is invalid.');
  if (platform === 'darwin') return { executable: '/usr/bin/open', arguments: [launchUrl] };
  if (platform === 'linux') return { executable: '/usr/bin/xdg-open', arguments: [launchUrl] };
  throw new TypeError('Automatic browser launch is not yet supported on this platform.');
}

export async function openLocalBrowser(launchUrl: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const command = browserLaunchCommand(platform, launchUrl);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.executable, [...command.arguments], {
      detached: true,
      stdio: 'ignore'
    });
    child.once('error', () => {
      reject(new Error('The trusted local browser launcher could not start.'));
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function runTrustedLocalLauncher(
  dependencies: ApiDependencies,
  options: StartLocalWebApplicationOptions,
  signal: AbortSignal,
  openBrowser: (launchUrl: string) => Promise<void> = openLocalBrowser,
  openTimeoutMs = browserOpenTimeoutMs
): Promise<void> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(openTimeoutMs) || openTimeoutMs < 100 || openTimeoutMs > 30_000) {
    throw new TypeError('The browser-open deadline is invalid.');
  }
  const running = await startLocalWebApplication(dependencies, options);
  let resolveStop: (() => void) | undefined;
  const stop = (): void => { resolveStop?.(); };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (signal.aborted) return;
    const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
    signal.addEventListener('abort', stop, { once: true });
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        reject(new Error('The trusted local browser launcher exceeded its deadline.'));
      }, openTimeoutMs);
      timeout.unref();
    });
    const outcome = await Promise.race([
      openBrowser(running.launchUrl).then(() => 'opened' as const),
      stopped.then(() => 'stopped' as const),
      deadline
    ]);
    if (outcome === 'opened') await stopped;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal.removeEventListener('abort', stop);
    await running.close();
  }
}
