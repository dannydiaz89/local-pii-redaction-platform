import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { repositoryRoot } from './schema-utils.js';

export const syntheticCorpusRoot = resolve(repositoryRoot, 'sample-data');
export const syntheticManifestPath = resolve(syntheticCorpusRoot, 'manifest.json');

interface SyntheticEntityRecipe {
  readonly id: string;
  readonly entityType: string;
  readonly line?: string;
  readonly value: string;
  readonly replacement: string;
}

export interface SyntheticGroundTruthEntity {
  readonly id: string;
  readonly entityType: string;
  readonly start: number;
  readonly end: number;
  readonly nativeLocation: {
    readonly line: number;
    readonly columnStart: number;
    readonly columnEnd: number;
  };
  readonly attributes: Readonly<Record<string, string>>;
  readonly allowedAmbiguity: false;
  readonly expectedReplacement: string;
}

export interface SyntheticCorpusManifest {
  readonly schemaVersion: '1.0.0';
  readonly corpusId: 'rules-only-text-v1';
  readonly generator: {
    readonly id: 'local-pii-synthetic-text';
    readonly version: '1.1.0';
    readonly seed: 'local-pii-rules-only-2026-08-09';
    readonly recipe: 'tooling/synthetic-corpus.ts#createSyntheticCorpus';
  };
  readonly provenance: {
    readonly classification: 'SYNTHETIC';
    readonly license: 'AGPL-3.0-only';
    readonly approvedForRepository: true;
  };
  readonly exclusionRules: readonly string[];
  readonly documents: readonly [{
    readonly id: 'sample-rules-only-text';
    readonly language: 'en';
    readonly locale: 'en-US';
    readonly format: 'TEXT';
    readonly mediaType: 'text/plain';
    readonly features: readonly string[];
    readonly inputPath: 'input/sample.txt';
    readonly expectedPath: 'expected/sample.redacted.txt';
    readonly inputDigest: string;
    readonly expectedDigest: string;
    readonly groundTruth: {
      readonly offsetUnit: 'UNICODE_CODE_POINT';
      readonly entities: readonly SyntheticGroundTruthEntity[];
    };
    readonly expectedPolicyOutcome: {
      readonly policyId: 'development-labels';
      readonly action: 'TYPED_LABEL';
      readonly verification: 'PASS';
    };
  }];
}

export interface SyntheticCorpus {
  readonly input: string;
  readonly expected: string;
  readonly manifest: SyntheticCorpusManifest;
  readonly canaryValues: readonly string[];
}

const entityRecipes: readonly SyntheticEntityRecipe[] = [
  {
    id: 'email-1', entityType: 'EMAIL',
    line: 'Résumé owner 👩🏽‍💻: alpha@example.test.',
    value: 'alpha@example.test', replacement: '[EMAIL_1]'
  },
  {
    id: 'email-2', entityType: 'EMAIL',
    line: 'Escalation (after hours): ops.team+night@example.invalid;',
    value: 'ops.team+night@example.invalid', replacement: '[EMAIL_2]'
  },
  {
    id: 'phone-1', entityType: 'PHONE',
    line: 'Primary phone: +1 (202) 555-0147.',
    value: '+1 (202) 555-0147', replacement: '[PHONE_1]'
  },
  {
    id: 'phone-2', entityType: 'PHONE',
    line: 'International callback: +44 7700 900123;',
    value: '+44 7700 900123', replacement: '[PHONE_2]'
  },
  {
    id: 'ssn-1', entityType: 'SSN',
    line: 'Synthetic tax identifier: 123-45-6789.',
    value: '123-45-6789', replacement: '[SSN_1]'
  },
  {
    id: 'card-1', entityType: 'CREDIT_CARD',
    line: 'Test payment card (spaced): 4242 4242 4242 4242.',
    value: '4242 4242 4242 4242', replacement: '[CREDIT_CARD_1]'
  },
  {
    id: 'card-2', entityType: 'CREDIT_CARD',
    line: 'Test payment card (hyphenated): 4000-0000-0000-0002;',
    value: '4000-0000-0000-0002', replacement: '[CREDIT_CARD_2]'
  },
  {
    id: 'ipv4-1', entityType: 'IP_ADDRESS',
    line: 'Audit endpoint: primary=192.0.2.10.',
    value: '192.0.2.10', replacement: '[IP_ADDRESS_1]'
  },
  {
    id: 'ipv4-2', entityType: 'IP_ADDRESS',
    line: 'Reserved failover host: 198.51.100.42.',
    value: '198.51.100.42', replacement: '[IP_ADDRESS_2]'
  },
  {
    id: 'ipv6-1', entityType: 'IP_ADDRESS',
    line: 'IPv6 documentation endpoint: [2001:db8::1].',
    value: '2001:db8::1', replacement: '[IP_ADDRESS_3]'
  },
  {
    id: 'api-key-1', entityType: 'API_KEY',
    line: 'Service config: API_KEY = "synthetic_value_12345"',
    value: 'synthetic_value_12345', replacement: '[API_KEY_1]'
  },
  {
    id: 'access-token-1', entityType: 'ACCESS_TOKEN',
    line: "Worker config: access-token = 'sandbox/token_value_67890'",
    value: 'sandbox/token_value_67890', replacement: '[ACCESS_TOKEN_1]'
  },
  {
    id: 'password-1', entityType: 'PASSWORD',
    line: 'Legacy config: password: "correct-horse-battery-9"',
    value: 'correct-horse-battery-9', replacement: '[PASSWORD_1]'
  },
  {
    id: 'email-3', entityType: 'EMAIL',
    value: 'release.manager@example.test', replacement: '[EMAIL_3]'
  },
  {
    id: 'phone-3', entityType: 'PHONE',
    value: '+1 (415) 555-0136', replacement: '[PHONE_3]'
  },
  {
    id: 'ipv4-3', entityType: 'IP_ADDRESS',
    value: '203.0.113.77', replacement: '[IP_ADDRESS_4]'
  }
];

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function codePointIndex(text: string, utf16Index: number): number {
  return Array.from(text.slice(0, utf16Index)).length;
}

export function createSyntheticCorpus(): SyntheticCorpus {
  const header = [
    'Synthetic PII detector demonstration — complex rules-only fixture',
    'Unicode context: Cafe\u0301, naïve, Ελληνικά, العربية, 日本語, and emoji 🚦.'
  ];
  const nearMisses = [
    'Expected unchanged near-misses: alpha@example and api_key=short.',
    'Calendar-only value: 1991-07-14 (rules-only does not infer date-of-birth context).'
  ];
  const naturalLanguageParagraph = [
    'Later, a fictional support note asked the overnight team to email',
    'release.manager@example.test, call +1 (415) 555-0136, and investigate a connection from',
    '203.0.113.77. The note deliberately surrounds each value with ordinary prose so sentence',
    'punctuation and natural-language offsets are tested.'
  ].join(' ');
  const footer = 'All values in this file are reserved examples or intentionally synthetic test data.';
  const structuredLines = entityRecipes.flatMap(({ line }) => line === undefined ? [] : [line]);
  const input = [
    ...header,
    '',
    ...structuredLines,
    '',
    naturalLanguageParagraph,
    '',
    ...nearMisses,
    '',
    footer,
    ''
  ].join('\n');
  const entities = entityRecipes.map((recipe) => {
    const startUtf16 = input.indexOf(recipe.value);
    if (startUtf16 < 0 || input.indexOf(recipe.value, startUtf16 + 1) >= 0) {
      throw new Error(`Synthetic canary ${recipe.id} must occur exactly once`);
    }
    const lineStart = input.lastIndexOf('\n', startUtf16 - 1) + 1;
    const line = input.slice(0, lineStart).split('\n').length;
    const start = codePointIndex(input, startUtf16);
    const end = start + Array.from(recipe.value).length;
    const columnStart = codePointIndex(input.slice(lineStart), startUtf16 - lineStart) + 1;
    return {
      id: recipe.id,
      entityType: recipe.entityType,
      start,
      end,
      nativeLocation: { line, columnStart, columnEnd: columnStart + Array.from(recipe.value).length },
      attributes: { provenance: 'synthetic', testClass: 'reserved-example' },
      allowedAmbiguity: false,
      expectedReplacement: recipe.replacement
    } satisfies SyntheticGroundTruthEntity;
  });

  let expected = input;
  for (const recipe of [...entityRecipes].reverse()) {
    const index = expected.indexOf(recipe.value);
    expected = `${expected.slice(0, index)}${recipe.replacement}${expected.slice(index + recipe.value.length)}`;
  }

  const manifest: SyntheticCorpusManifest = {
    schemaVersion: '1.0.0',
    corpusId: 'rules-only-text-v1',
    generator: {
      id: 'local-pii-synthetic-text',
      version: '1.1.0',
      seed: 'local-pii-rules-only-2026-08-09',
      recipe: 'tooling/synthetic-corpus.ts#createSyntheticCorpus'
    },
    provenance: { classification: 'SYNTHETIC', license: 'AGPL-3.0-only', approvedForRepository: true },
    exclusionRules: [
      'No production or private documents',
      'No real personal data',
      'No live credentials or routable infrastructure addresses'
    ],
    documents: [{
      id: 'sample-rules-only-text',
      language: 'en',
      locale: 'en-US',
      format: 'TEXT',
      mediaType: 'text/plain',
      features: [
        'unicode-code-point-offsets',
        'astral-emoji',
        'combining-mark',
        'rtl-context',
        'repeated-entity-types',
        'punctuation-boundaries',
        'quoted-assignment-context',
        'natural-language-prose',
        'safe-near-misses',
        'ipv4-reserved-range',
        'ipv6-documentation-prefix'
      ],
      inputPath: 'input/sample.txt',
      expectedPath: 'expected/sample.redacted.txt',
      inputDigest: sha256(input),
      expectedDigest: sha256(expected),
      groundTruth: { offsetUnit: 'UNICODE_CODE_POINT', entities },
      expectedPolicyOutcome: { policyId: 'development-labels', action: 'TYPED_LABEL', verification: 'PASS' }
    }]
  };
  return { input, expected, manifest, canaryValues: entityRecipes.map(({ value }) => value) };
}

export async function readCommittedSyntheticCorpus(): Promise<{
  readonly input: string;
  readonly expected: string;
  readonly manifestText: string;
}> {
  const document = createSyntheticCorpus().manifest.documents[0];
  const [input, expected, manifestText] = await Promise.all([
    readFile(resolve(syntheticCorpusRoot, document.inputPath), 'utf8'),
    readFile(resolve(syntheticCorpusRoot, document.expectedPath), 'utf8'),
    readFile(syntheticManifestPath, 'utf8')
  ]);
  return { input, expected, manifestText };
}

export function serializeSyntheticManifest(manifest: SyntheticCorpusManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
