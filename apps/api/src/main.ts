import { fileURLToPath } from 'node:url';

import { localTextApplication } from '@local-pii/profile-local';

import { runTrustedLocalLauncher } from './launcher.js';

const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));

async function main(): Promise<void> {
  const lifecycle = new AbortController();
  const stopFor = (exitCode: number): void => {
    process.exitCode = exitCode;
    lifecycle.abort();
  };
  const interrupt = (): void => { stopFor(130); };
  const terminate = (): void => { stopFor(143); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    await runTrustedLocalLauncher({
      application: localTextApplication,
      readiness: { check: (signal) => { signal?.throwIfAborted(); return Promise.resolve(); } }
    }, { webRoot }, lifecycle.signal);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

try {
  await main();
} catch {
  process.stderr.write('The local application could not be started safely.\n');
  process.exitCode = 1;
}
