#!/usr/bin/env node

import { executeCli } from './commands.js';
import { createProcessSignalController } from './signals.js';

const signals = createProcessSignalController(process);
try {
  process.exitCode = await executeCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  }, { signal: signals.signal, getCancellationExitCode: () => signals.exitCode });
} finally {
  signals.dispose();
}
