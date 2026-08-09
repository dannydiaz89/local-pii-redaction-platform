import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  createSyntheticCorpus,
  readCommittedSyntheticCorpus,
  serializeSyntheticManifest,
  syntheticCorpusRoot,
  syntheticManifestPath
} from './synthetic-corpus.js';

const generated = createSyntheticCorpus();
const document = generated.manifest.documents[0];
const expectedManifest = serializeSyntheticManifest(generated.manifest);
const write = process.argv.slice(2).includes('--write');

if (write) {
  await Promise.all([
    mkdir(resolve(syntheticCorpusRoot, 'input'), { recursive: true }),
    mkdir(resolve(syntheticCorpusRoot, 'expected'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(resolve(syntheticCorpusRoot, document.inputPath), generated.input, 'utf8'),
    writeFile(resolve(syntheticCorpusRoot, document.expectedPath), generated.expected, 'utf8'),
    writeFile(syntheticManifestPath, expectedManifest, 'utf8')
  ]);
  console.log('Generated deterministic synthetic text corpus.');
} else {
  const committed = await readCommittedSyntheticCorpus();
  const drift: string[] = [];
  if (committed.input !== generated.input) drift.push(document.inputPath);
  if (committed.expected !== generated.expected) drift.push(document.expectedPath);
  if (committed.manifestText !== expectedManifest) drift.push('manifest.json');
  if (drift.length > 0) {
    throw new Error(`Synthetic fixtures drifted: ${drift.join(', ')}. Run pnpm fixtures:generate.`);
  }
  console.log(`Synthetic corpus is reproducible: ${String(generated.manifest.documents.length)} document, ${String(generated.canaryValues.length)} canaries.`);
}
