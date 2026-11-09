# Vendored padding-line-between-statements

Source: [ESLint Stylistic](https://github.com/eslint-stylistic/eslint-stylistic), commit `435c3ea0fd26a5fef9042c4b36b6e165fbbf8d08`.

Files:

- `padding-line-between-statements.mjs`, ported to ESM JavaScript from `packages/eslint-plugin/rules/padding-line-between-statements/padding-line-between-statements.ts`.
- `padding-line-ast.mjs`, the few AST helpers the rule needs, written against the ESLint source-code and token API.
- Root `LICENSE`, retained verbatim. Both OpenJS Foundation and ESLint Stylistic notices apply.

The rule is MIT-licensed. Keep `LICENSE` with every redistributed copy. It needs no Stylistic runtime dependency.

## Local adaptations

- `AST_NODE_TYPES` enum members become identical string literals.
- Impossible missing AST entries raise explicit invariant errors.
- The repository-specific `createRule` factory becomes the default export `createPaddingLineRule(options)`. The anti-slop wrapper supplies the options and exposes no user configuration.
- `isParenthesized` only checks the single pair of parentheses that excludes parenthesized directive strings.
- Upstream statement matchers, scope tracking, comment-aware insertion and removal, selector support and diagnostic text are kept as they were, so future upstream diffs stay reviewable. The file is not a model for new application code.

The policy lives in `../../rules/require-readable-spacing.mjs`. It adds blank lines without collapsing existing ones. Short local bindings, consecutive imports and adjacent overload signatures stay grouped.

## Updating and verification

Fetch an explicit upstream revision, compare the original rule with this port and carry over relevant fixes. Update this record and keep the license. `bun run lint` runs `../../_tests_/require-readable-spacing.mjs` with the other RuleTester suites. Those cases cover the local policy; the complete upstream suites are not ported.
