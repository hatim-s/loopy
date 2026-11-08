import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compile } from "@loopy/compiler";
import { requireRecord } from "@loopy/core";
import { LocalExecutor } from "@loopy/runtime/executor";
import { activate } from "@loopy/runtime/host";
import { makeLocalService, Registry } from "@loopy/runtime/local";
import { openRunStore } from "@loopy/runtime/store";
import { Effect } from "effect";

export const roots: string[] = [];

export const CLI = resolve(import.meta.dir, "../../cli/src/index.ts");

export const SDK = "loopy";

export function fixture(name: string, definition: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "loopy-cli-sdk-")));
  roots.push(root);
  mkdirSync(join(root, ".loopy", "loopies"), { recursive: true });
  const home = join(root, "home");
  const file = join(root, `${name}.loopy.ts`);
  writeFileSync(
    file,
    `import { loopy, log, sh, code, sleep, wait } from ${JSON.stringify(SDK)};
export default loopy(${JSON.stringify(name)}, { input: {}, ${definition} });`,
  );

  return { cwd: root, home, file };
}

export async function cli(f: ReturnType<typeof fixture>, ...args: string[]) {
  const child = Bun.spawn([process.execPath, CLI, "--home", f.home, ...args], {
    cwd: f.cwd,
    env: { PATH: process.env.PATH, HOME: f.cwd, TMPDIR: f.cwd, LOOPY_HOME: f.home },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, code };
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
          clock: { now: Date.now },
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
          clock: { now: Date.now },
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
