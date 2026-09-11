import { fileURLToPath } from 'node:url';

import { SafeError } from '@local-pii/domain';
import {
  createExperimentalOllamaTextApplication,
  createProcessLocalApiPolicyCatalog,
  localApiApplication
} from '@local-pii/profile-local';

import { runTrustedLocalLauncher } from './launcher.js';
import { createLocalPreviewScan } from './preview-scan.js';
import { createVolatileProcessingControl } from './processing.js';
import { localStartupUsage, parseLocalStartupOptions } from './startup-options.js';

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
    const options = parseLocalStartupOptions(process.argv.slice(2));
    const policyCatalog = createProcessLocalApiPolicyCatalog();
    // The experimental engine is prepared once here: the model digest is pinned for the whole
    // session and every job's scan, redaction, and contextual rescan uses that same instance.
    const application = options.engine === 'ollama'
      ? await createExperimentalOllamaTextApplication({
        model: options.model ?? '',
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        profile: 'process-local-api',
        signal: lifecycle.signal
      })
      : localApiApplication;
    if (options.engine === 'ollama') {
      process.stderr.write('EXPERIMENTAL: Ollama hybrid detection is unqualified; classifications may be wrong and confidence is an uncalibrated provider constant. Model evidence is held for review.\n');
    }
    const processing = createVolatileProcessingControl(application, policyCatalog.policies, { engine: options.engine });
    await runTrustedLocalLauncher({
      application,
      jobs: processing,
      processing,
      policies: { get: (signal) => { signal?.throwIfAborted(); return Promise.resolve(policyCatalog); } },
      preview: createLocalPreviewScan(application, { engine: options.engine }),
      readiness: { check: (signal) => { signal?.throwIfAborted(); return Promise.resolve(); } }
    }, { webRoot }, lifecycle.signal);
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

try {
  await main();
} catch (error: unknown) {
  // Usage and provider errors carry no document content; anything else stays generic.
  if (error instanceof TypeError) {
    process.stderr.write(`${error.message}\n${localStartupUsage}\n`);
  } else if (error instanceof SafeError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
  } else {
    process.stderr.write('The local application could not be started safely.\n');
  }
  process.exitCode = 1;
}
