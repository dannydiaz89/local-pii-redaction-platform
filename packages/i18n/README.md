# `@local-pii/i18n`

Typed, offline localization catalogs and locale-formatting helpers for the web application.

## Responsibilities

- Defines the supported application locales and text direction.
- Uses the independent English source catalog in `src/catalogs/en.ts`.
- Generates expansion and RTL development pseudolocales.
- Provides typed message parameters and locale-aware integer formatting.
- Rejects missing, unused, unsafe, or structurally incompatible catalog entries in tests.

## Adding a language

Place a new static catalog beside `src/catalogs/en.ts`, add its locale to `supportedLocales`, and
extend the conformance tests. Catalogs must remain bundled and offline; entries are plain text, not
HTML, and must never contain document values or canonical wire identifiers.

```sh
pnpm --filter @local-pii/i18n build
pnpm exec vitest run packages/i18n/test
```
