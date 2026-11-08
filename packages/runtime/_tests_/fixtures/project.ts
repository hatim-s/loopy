import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "@loopy/compiler";
import { requireRecord } from "@loopy/core";
import { Effect } from "effect";
import { LocalExecutor } from "../../src/executor";
import { activate } from "../../src/host";
import { makeLocalService, Registry } from "../../src/local";
import { openRunStore } from "../../src/store";
import { qualityTestRoot } from "./quality-test-root";

/** A project directory holding one author definition and its Loopy home. */
export function fixture(name: string, definition: string) {
  const root = qualityTestRoot("project");
  const home = join(root, "home");
  const file = join(root, `${name}.loopy.ts`);
  writeFileSync(
    file,
    `import { loopy, log, sh, code, sleep, wait } from "loopy";
export default loopy(${JSON.stringify(name)}, { input: {}, ${definition} });`,
  );

  return { cwd: root, home, file };
}

export function object(text: string) {
  return requireRecord(JSON.parse(text), "CLI output");
}

export async function save(f: ReturnType<typeof fixture>) {
  const result = await Effect.runPromise(compile(f.file));

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openRunStore(f.home);

        const service = makeLocalService({
          store,
          home: f.home,
        });

        yield* service.putLoopy(result.graph.name, {
          ...result,
          bundles: result.bundles,
          source: { path: f.file, workspace: f.cwd },
          replace: false,
        });
        const registry = yield* Registry.make(f.home, f.cwd);

        return yield* registry.get(result.graph.name);
      }),
    ),
  );
}

export async function runFixture(f: ReturnType<typeof fixture>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* Registry.make(f.home, f.cwd);
        const saved = (yield* registry.list())[0];

        if (!saved) {
          throw new Error("Save fixture before running it.");
        }

        const store = yield* openRunStore(f.home);

        const service = makeLocalService({
          store,
          home: f.home,
        });

        const run = yield* service.startRun(saved.slug, {}, f.cwd);
        yield* activate({
          store,
          runId: run.id,
          graph: saved.graph,
          executor: new LocalExecutor({
            home: f.home,
            workspace: f.cwd,
            mode: saved.graph.meta.mode,
            secrets: saved.graph.meta.secrets,
            bundlePath: (hash) => registry.bundlePath(hash),
          }),
        });

        return { stdout: JSON.stringify(yield* store.getRun(run.id)), stderr: "", code: 0 };
      }),
    ),
  );
}
