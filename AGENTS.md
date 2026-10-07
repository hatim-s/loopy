# Working in this repo

Read this before changing code. `bun run check` must pass before a PR; it builds, lints,
typechecks and runs the tests. The architecture test fails the build on import-rule violations.

## Where code goes

```
packages/loopy/src/
  core/      types, authoring DSL, validation. Pure. No node:* or bun:* imports.
  runtime/   run execution against a RunRepository. Pure.
  cloud/     queue worker on top of runtime. Pure.
  local/     SQLite, filesystem, subprocesses, sandbox, HTTP server. Owns the OS.
  cli/       one file per command in cli/commands/, dispatched from cli/index.ts.
apps/studio/src/
  components/  one component per file     hooks/  state and effects     lib/  pure helpers
packages/loopy/_tests_/   all tests. No tests next to source.
```

Layers import downward only: `cli -> local -> runtime -> core`, `cloud -> runtime -> core`.
Cross-layer imports go through the target layer's `index.ts`. Same-layer imports use the
file path. Studio imports the package only as `"loopy"`.

Adding a feature: put the data shape in `core/model.ts` and its validation next to it, the OS
work in `local/`, the command in `cli/commands/<name>.ts` registered in the dispatch table. A
new store column means SQL and row types in `local/store-schema.ts` and queries in
`local/store.ts`. A new Studio panel is a component in `components/`, its state in a hook in
`hooks/`, wired through `use-studio.ts` and `app.tsx`. A new file gets one responsibility and a
kebab-case name; related files share a folder without an inner `index.ts`.

## Patterns to follow

**Narrow unknown data with guards, not casts.** Generic guards (`requireRecord`,
`isStringArray`) live in `core/validation.ts`; checks that know the domain (`validateWorkflow`,
`validateSlug`) live next to the type they check.

```ts
// bad
const body = (await request.json()) as Record<string, unknown>;
if (typeof body.slug !== "string") throw new Error("slug missing");

// good
const body = requireRecord(await request.json(), "The request body");
allowKeys(body, "The request body", ["slug", "mode", "input"]);
const slug = requireNonEmptyString(body.slug, "slug");
```

**Reuse the shared helpers instead of writing a local copy.** `errorMessage`,
`latestAttempts`, `validateSlug` and friends in `core/names.ts`, `setOwnProperty`,
`errnoCode`, `withLockDirectory`, `writeFileAtomically` in `local/fs.ts`. Before adding a
helper, grep for the behaviour.

**One command, one file, one context.** A CLI command is `export async function
run<Name>(context: CliContext)`. It reads its arguments through `requireTarget` or
`optionalTarget`, prints through `printJson` and `report`, and never parses argv itself.

```ts
// bad: logic inlined into a switch in cli/index.ts
case "graph": print(registry.get(required(target, "Slug")).workflow); return;

// good: cli/commands/graph.ts
export async function runGraph(context: CliContext): Promise<void> {
  const registry = new Registry(context.home, context.cwd);
  printJson(registry.get(requireTarget(context, "Slug")).workflow);
}
```

**Braces and early returns.** Every `if`, `for` and `while` body is a block. Check the
failure case first and return or throw; keep the happy path at the left margin.

**Error messages end with a period and say what failed and what to do.**
`No saved loopy 'review'. Use loopy save <file.ts> first.` not `not found`.

**Types describe the data, not the code.** `type` for shapes, `interface` only for a
contract a class implements (`RunRepository`). Let inference carry local variables. Shared
shapes (`WorkflowSummary`, `RunEventType`) live in `core/model.ts`; do not redeclare them in
Studio or the CLI.

**Naming.** `export function` for top-level functions. `SCREAMING_SNAKE_CASE` for module
constants and regexes, `camelCase` for everything else. Files kebab-case.

**Comments explain why.** A one-line `/** */` on an export only when the name does not
already say it. No banners, no restating the code, no em dashes.

## Patterns to avoid

- A function the linter rejects for cognitive complexity. Split it; do not raise the limit.
- A file that holds two jobs (parsing and rendering, schema and queries). Split it.
- `export const name = () => ...` at module level.
- `(error as NodeJS.ErrnoException).code`: use `errnoCode(error)`.
- Importing `../local/registry/registry.js` from `cli/`, or re-exporting one layer's function
  from another to shorten a path. Use the barrel.
- Exporting from a barrel because it might be useful. Export what another layer or a package
  consumer uses today.
- Compatibility shims, deprecated aliases, or keeping an old path alive. Move it and fix the callers.
- Tests for glue. Test invariants: types, sandbox confinement, durable state, CLI behaviour.
