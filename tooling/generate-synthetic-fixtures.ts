import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  contextualCorpusRoot,
  contextualManifestPath,
  createContextualCorpus,
  readCommittedContextualCorpus,
  serializeContextualManifest
} from './contextual-corpus.js';

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
const contextual = createContextualCorpus();
const expectedContextualManifest = serializeContextualManifest(contextual.manifest);
const write = process.argv.slice(2).includes('--write');

if (write) {
  await Promise.all([
    mkdir(resolve(syntheticCorpusRoot, 'input'), { recursive: true }),
    mkdir(resolve(syntheticCorpusRoot, 'expected'), { recursive: true }),
    ...contextual.documents.map(({ inputPath }) => mkdir(dirname(resolve(contextualCorpusRoot, inputPath)), { recursive: true }))
  ]);
  await Promise.all([
    writeFile(resolve(syntheticCorpusRoot, document.inputPath), generated.input, 'utf8'),
    writeFile(resolve(syntheticCorpusRoot, document.expectedPath), generated.expected, 'utf8'),
    writeFile(syntheticManifestPath, expectedManifest, 'utf8'),
    ...contextual.documents.map(({ inputPath, text }) => writeFile(resolve(contextualCorpusRoot, inputPath), text, 'utf8')),
    writeFile(contextualManifestPath, expectedContextualManifest, 'utf8')
  ]);
  console.log('Generated deterministic rules and contextual synthetic corpora.');
} else {
  const [committed, committedContextual] = await Promise.all([
    readCommittedSyntheticCorpus(),
    readCommittedContextualCorpus()
  ]);
  const drift: string[] = [];
  if (committed.input !== generated.input) drift.push(document.inputPath);
  if (committed.expected !== generated.expected) drift.push(document.expectedPath);
  if (committed.manifestText !== expectedManifest) drift.push('manifest.json');
  const committedContextualByPath = new Map(committedContextual.documents.map(({ inputPath, text }) => [inputPath, text]));
  for (const contextualDocument of contextual.documents) {
    if (committedContextualByPath.get(contextualDocument.inputPath) !== contextualDocument.text) {
      drift.push(`contextual/${contextualDocument.inputPath}`);
    }
  }
  if (committedContextual.manifestText !== expectedContextualManifest) drift.push('contextual/manifest.json');
  if (drift.length > 0) {
    throw new Error(`Synthetic fixtures drifted: ${drift.join(', ')}. Run pnpm fixtures:generate.`);
  }
  console.log([
    `Synthetic corpora are reproducible: ${String(generated.manifest.documents.length)} rules document,`,
    `${String(contextual.documents.length)} contextual harness documents,`,
    `${String(generated.canaryValues.length)} privacy canaries.`
  ].join(' '));
}
