import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { repositoryRoot } from './schema-utils.js';

interface TestTaxonomy {
  readonly schemaVersion: string;
  readonly categories: Readonly<Record<string, {
    readonly status: 'ACTIVE' | 'PLANNED';
    readonly purpose: string;
    readonly milestone?: string;
  }>>;
  readonly tests: Readonly<Record<string, readonly string[]>>;
  readonly executableGates: Readonly<Record<string, readonly string[]>>;
}

async function findTests(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return findTests(path);
    return path.endsWith('.test.ts') || path.endsWith('.test.tsx') ? [relative(repositoryRoot, path)] : [];
  }));
  return nested.flat();
}

const taxonomyPath = resolve(repositoryRoot, 'tooling/test-taxonomy.json');
const taxonomy = JSON.parse(await readFile(taxonomyPath, 'utf8')) as TestTaxonomy;
const discovered = (await Promise.all([
  findTests(resolve(repositoryRoot, 'apps')),
  findTests(resolve(repositoryRoot, 'packages')),
  findTests(resolve(repositoryRoot, 'tooling'))
])).flat().sort();
const declared = Object.keys(taxonomy.tests).sort();

if (taxonomy.schemaVersion !== '1.0.0') throw new Error('Unsupported test taxonomy version');
const categoryNames = Object.keys(taxonomy.categories);
if (categoryNames.length === 0) throw new Error('Test taxonomy must declare categories');
if (JSON.stringify(discovered) !== JSON.stringify(declared)) {
  const missing = discovered.filter((path) => !declared.includes(path));
  const stale = declared.filter((path) => !discovered.includes(path));
  throw new Error(`Test taxonomy drifted. Unclassified: ${missing.join(', ') || 'none'}. Stale: ${stale.join(', ') || 'none'}.`);
}

const used = new Set<string>();
for (const [path, categories] of Object.entries(taxonomy.tests)) {
  if (categories.length === 0) throw new Error(`${path} has no test category`);
  for (const category of categories) {
    if (!(category in taxonomy.categories)) throw new Error(`${path} uses unknown category ${category}`);
    if (taxonomy.categories[category]?.status !== 'ACTIVE') throw new Error(`${path} uses planned category ${category}`);
    used.add(category);
  }
}
for (const [category, commands] of Object.entries(taxonomy.executableGates)) {
  if (!(category in taxonomy.categories) || taxonomy.categories[category]?.status !== 'ACTIVE' || commands.length === 0) {
    throw new Error(`Invalid executable gate declaration for ${category}`);
  }
  used.add(category);
}
for (const [category, definition] of Object.entries(taxonomy.categories)) {
  if (definition.purpose.length < 10) throw new Error(`${category} lacks a useful purpose`);
  if (definition.status === 'PLANNED' && (definition.milestone === undefined || definition.milestone.length === 0)) {
    throw new Error(`${category} lacks a planned milestone`);
  }
}
const unused = categoryNames.filter((category) => taxonomy.categories[category]?.status === 'ACTIVE' && !used.has(category));
if (unused.length > 0) throw new Error(`Test categories lack evidence: ${unused.join(', ')}`);

const activeCount = Object.values(taxonomy.categories).filter(({ status }) => status === 'ACTIVE').length;
console.log(`Test taxonomy covers ${String(declared.length)} test files across ${String(activeCount)} active and ${String(categoryNames.length - activeCount)} planned categories.`);
