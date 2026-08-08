#!/usr/bin/env node

import { executeCli } from './commands.js';

const exitCode = await executeCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text)
});
process.exitCode = exitCode;
