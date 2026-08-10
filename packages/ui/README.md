# `@local-pii/ui`

Accessible React primitives and semantic design tokens shared by local web screens.

## Responsibilities

- Provides small native-first primitives such as `Button`, `Card`, `Callout`, `StatusBadge`,
  `Metric`, `SelectField`, and `FileField`.
- Defines shared color, spacing, typography, focus, motion, and layout behavior in `styles.css`.
- Includes a semantic detected-text highlight token while keeping category and location text as the
  non-color review signal.
- Supports keyboard use, visible focus, logical properties, reduced motion, and forced colors.

## Boundary

This package owns reusable presentation primitives, not business workflows, API calls, routing, or
user-facing copy. Components accept already-localized text from consumers. Prefer native HTML
semantics; add ARIA behavior only for widgets that cannot be represented natively.

Import components from `@local-pii/ui` and styles from `@local-pii/ui/styles.css`.

```sh
pnpm --filter @local-pii/ui build
pnpm exec vitest run packages/ui/test
```
