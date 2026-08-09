import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['eslint.config.mjs', '**/dist/**', '**/node_modules/**', 'packages/contracts/src/generated/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./packages/*/tsconfig.json', './apps/*/tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-import-type-side-effects': 'error'
    }
  },
  {
    ...tseslint.configs.disableTypeChecked,
    files: [
      'tooling/ephemeral-profile-network-guard.cjs',
      'tooling/ephemeral-profile-network-guard-self-test.mjs',
      'tooling/ephemeral-profile-signal-stage-gate.cjs'
    ],
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: { console: 'readonly', fetch: 'readonly', process: 'readonly', require: 'readonly' }
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
);
