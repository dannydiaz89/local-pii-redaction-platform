import { defineConfig } from 'vitest/config';

export default defineConfig({
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
