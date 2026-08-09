import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { repositoryRoot } from './schema-utils.js';

interface AutomatedResolution {
  readonly type: 'AUTOMATED';
  readonly evidence: readonly string[];
  readonly command: string;
}

interface ReviewResolution {
  readonly type: 'REVIEW';
  readonly owner: string;
  readonly milestone: string;
  readonly gate: string;
}

interface AdrControl {
  readonly id: string;
  readonly control: string;
  readonly resolution: AutomatedResolution | ReviewResolution;
}

interface AdrEntry {
  readonly id: string;
  readonly controls: readonly AdrControl[];
}

interface AdrControlMatrix {
  readonly schemaVersion: string;
  readonly adrs: readonly AdrEntry[];
  readonly validationGates: readonly {
    readonly id: string;
    readonly appliesTo: string;
    readonly owner: string;
    readonly gate: string;
  }[];
}

function parseRequiredControls(markdown: string): string[] {
  const required = markdown.split('## Required controls')[1]?.split('## Validation')[0];
  if (required === undefined) return [];
  return [...required.matchAll(/^\s*-\s+(.+)$/gmu)].map((match) => match[1]?.trim() ?? '');
}

const matrixPath = resolve(repositoryRoot, 'tooling/adr-control-matrix.json');
const matrix = JSON.parse(readFileSync(matrixPath, 'utf8')) as AdrControlMatrix;
const rootPackage = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Readonly<Record<string, string>>;
};
const scripts = rootPackage.scripts ?? {};

if (matrix.schemaVersion !== '1.0.0') throw new Error('Unsupported ADR control matrix version');
if (matrix.adrs.length !== 17) throw new Error(`Expected 17 accepted ADRs, found ${String(matrix.adrs.length)}`);

const ids = new Set<string>();
let automated = 0;
let review = 0;
for (const [adrIndex, adr] of matrix.adrs.entries()) {
  const expectedAdr = `ADR-${String(adrIndex + 1).padStart(3, '0')}`;
  if (adr.id !== expectedAdr) throw new Error(`Expected ${expectedAdr}, found ${adr.id}`);
  if (adr.controls.length !== 4) throw new Error(`${adr.id} must map exactly four required controls`);
  for (const [controlIndex, control] of adr.controls.entries()) {
    const expectedId = `${adr.id}-C${String(controlIndex + 1).padStart(2, '0')}`;
    if (control.id !== expectedId || ids.has(control.id)) throw new Error(`Invalid or duplicate ADR control ID: ${control.id}`);
    ids.add(control.id);
    if (control.control.length < 20) throw new Error(`${control.id} lacks the normative control text`);
    if (control.resolution.type === 'AUTOMATED') {
      automated += 1;
      if (control.resolution.evidence.length === 0) throw new Error(`${control.id} has no automated evidence`);
      for (const path of control.resolution.evidence) {
        const absolute = resolve(repositoryRoot, path);
        if (!existsSync(absolute) || !statSync(absolute).isFile()) throw new Error(`${control.id} evidence does not exist: ${path}`);
      }
      const script = /^pnpm ([a-z][a-z0-9:-]*)$/u.exec(control.resolution.command)?.[1];
      if (script === undefined || scripts[script] === undefined) {
        throw new Error(`${control.id} references an unknown root command: ${control.resolution.command}`);
      }
    } else {
      review += 1;
      if (control.resolution.owner.length < 3 || !/^M(?:[0-6]|4B)$/u.test(control.resolution.milestone)
        || control.resolution.gate.length < 30) {
        throw new Error(`${control.id} has an incomplete review gate`);
      }
    }
  }
}

const requiredValidationGates = ['ADR-VAL-CONTRACT', 'ADR-VAL-E2E', 'ADR-VAL-SECURITY', 'ADR-VAL-CPU'];
if (JSON.stringify(matrix.validationGates.map(({ id }) => id)) !== JSON.stringify(requiredValidationGates)
  || matrix.validationGates.some(({ appliesTo, owner, gate }) =>
    appliesTo !== 'ALL_ACCEPTED_ADRS' || owner.length < 3 || gate.length < 30)) {
  throw new Error('ADR-wide validation gates are incomplete');
}

const adrDirectory = resolve(repositoryRoot, 'docs/adr');
if (existsSync(adrDirectory)) {
  const accepted = readdirSync(adrDirectory)
    .filter((name) => /^ADR-[0-9]{3}-.+\.md$/u.test(name))
    .sort()
    .flatMap((name) => {
      const markdown = readFileSync(resolve(adrDirectory, name), 'utf8');
      if (!/Status:\s*\*\*Accepted\*\*/u.test(markdown)) return [];
      const id = basename(name).slice(0, 7);
      return [{ id, controls: parseRequiredControls(markdown) }];
    });
  if (accepted.length !== matrix.adrs.length) throw new Error('Accepted ADR count drifted from the control matrix');
  for (const [index, source] of accepted.entries()) {
    const declared = matrix.adrs[index];
    if (declared === undefined || source.id !== declared.id
      || JSON.stringify(source.controls) !== JSON.stringify(declared.controls.map(({ control }) => control))) {
      throw new Error(`${source.id} required controls drifted from tooling/adr-control-matrix.json`);
    }
  }
}

console.log(`ADR traceability covers ${String(ids.size)} controls: ${String(automated)} automated and ${String(review)} explicit review gates.`);
