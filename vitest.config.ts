import { readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Resolve every workspace package to its TypeScript source rather than its built `dist`.
 *
 * Each package exports only `./dist/index.js`, so without this a test that imports a sibling
 * package reads whatever was built last. Editing a package's source and running another
 * package's tests then exercises stale code and reports green, and a mutation made to source
 * to check whether a test is load-bearing kills nothing — which is indistinguishable from a
 * test that genuinely covers the mutated line.
 *
 * Each entry is anchored, so subpath exports such as `@local-pii/ui/styles.css` still resolve
 * through the package manifest. The built output is still what the boundary, SDK public-API,
 * and spawned-CLI gates inspect; those run the real `dist` on purpose.
 */
const workspaceSourceAliases = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap(({ name }) => {
    const entryPoint = ['index.ts', 'index.tsx']
      .map((file) => resolve(root, 'packages', name, 'src', file))
      .find((candidate) => existsSync(candidate));
    return entryPoint === undefined ? [] : [{ find: new RegExp(`^@local-pii/${name}$`, 'u'), replacement: entryPoint }];
  });

export default defineConfig({
  resolve: { alias: workspaceSourceAliases },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/test/**/*.test.tsx',
      'apps/*/test/**/*.test.ts',
      'apps/*/test/**/*.test.tsx',
      'tooling/**/*.test.ts'
    ],
    coverage: { reporter: ['text', 'json-summary'] }
  }
});
