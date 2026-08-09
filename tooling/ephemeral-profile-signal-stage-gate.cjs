'use strict';

// This preload is inert unless the spawned G1 child explicitly arms it. It
// pauses immediately after the first private text-stage readback, allowing the
// parent gate to deliver a real terminal signal before any publication step.
if (process.env.LOCAL_PII_SIGNAL_STAGE_GATE === '1') {
  const fs = require('node:fs');
  const fsPromises = require('node:fs/promises');
  const { syncBuiltinESMExports } = require('node:module');
  const path = require('node:path');
  const originalReadFile = fsPromises.readFile;
  let armed = true;

  function isTextStage(filePath) {
    return typeof filePath === 'string'
      && /^\..+\.staged\.(?:txt|md|markdown)$/u.test(path.basename(filePath));
  }

  async function gatedReadFile(filePath, ...options) {
    const value = await originalReadFile.call(fsPromises, filePath, ...options);
    if (!armed || !isTextStage(filePath)) return value;
    armed = false;
    if (typeof process.send !== 'function') {
      throw new Error('Signal-stage gate requires an IPC parent.');
    }
    const interrupted = new Promise((resolveResult) => {
      const keepAlive = globalThis.setInterval(() => undefined, 1_000);
      const release = () => {
        globalThis.clearInterval(keepAlive);
        resolveResult();
      };
      process.once('SIGINT', release);
      process.once('SIGTERM', release);
    });
    process.send({ type: 'LOCAL_PII_SIGNAL_STAGE_READY' });
    await interrupted;
    return value;
  }

  fsPromises.readFile = gatedReadFile;
  fs.promises.readFile = gatedReadFile;
  syncBuiltinESMExports();
}
