'use strict';

// This preload is inert unless a dedicated filesystem-failure evidence child
// explicitly selects a phase. It coordinates parent-owned permission changes
// around real filesystem operations; it never supplies data, paths, or a
// synthetic filesystem result to the application.
const selectedPhase = process.env.LOCAL_PII_FILESYSTEM_FAILURE_PHASE;

if (selectedPhase !== undefined) {
  const fs = require('node:fs');
  const fsPromises = require('node:fs/promises');
  const { syncBuiltinESMExports } = require('node:module');
  const path = require('node:path');

  const originalReadFile = fsPromises.readFile;
  const originalLink = fsPromises.link;
  const originalUnlink = fsPromises.unlink;
  const selectedPhases = new Set(selectedPhase.split(','));
  const reached = new Set();
  let stageReadCount = 0;

  function isTextStage(filePath) {
    return typeof filePath === 'string'
      && /^\..+\.staged\.(?:txt|md|markdown)$/u.test(path.basename(filePath));
  }

  async function checkpoint(name) {
    if (!selectedPhases.has(name) || reached.has(name) || typeof process.send !== 'function') return;
    reached.add(name);
    await new Promise((resolveResult) => {
      const onMessage = (message) => {
        if (message === null || typeof message !== 'object') return;
        if (message.type !== 'LOCAL_PII_FILESYSTEM_PHASE_CONTINUE' || message.checkpoint !== name) return;
        process.off('message', onMessage);
        resolveResult();
      };
      process.on('message', onMessage);
      process.send({ type: 'LOCAL_PII_FILESYSTEM_PHASE', checkpoint: name });
    });
  }

  async function coordinatedReadFile(filePath, ...options) {
    if (!isTextStage(filePath)) return originalReadFile.call(fsPromises, filePath, ...options);
    stageReadCount += 1;
    if (stageReadCount === 1) await checkpoint('FIRST_STAGE_READ_BEFORE');
    if (stageReadCount === 2) await checkpoint('SECOND_STAGE_READ_BEFORE');
    const value = await originalReadFile.call(fsPromises, filePath, ...options);
    if (stageReadCount === 1) await checkpoint('FIRST_STAGE_READ_AFTER');
    return value;
  }

  async function coordinatedLink(existingPath, targetPath) {
    await checkpoint('PUBLICATION_LINK_BEFORE');
    try {
      return await originalLink.call(fsPromises, existingPath, targetPath);
    } catch (error) {
      await checkpoint('PUBLICATION_LINK_REJECTED');
      throw error;
    }
  }

  async function coordinatedUnlink(filePath) {
    if (!isTextStage(filePath)) return originalUnlink.call(fsPromises, filePath);
    await checkpoint('STAGE_UNLINK_BEFORE');
    try {
      return await originalUnlink.call(fsPromises, filePath);
    } catch (error) {
      await checkpoint('STAGE_UNLINK_REJECTED');
      throw error;
    }
  }

  fsPromises.readFile = coordinatedReadFile;
  fsPromises.link = coordinatedLink;
  fsPromises.unlink = coordinatedUnlink;
  fs.promises.readFile = coordinatedReadFile;
  fs.promises.link = coordinatedLink;
  fs.promises.unlink = coordinatedUnlink;
  syncBuiltinESMExports();
}
