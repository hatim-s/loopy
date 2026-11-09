import { join } from "node:path";
import type { PutLoopyBody } from "@loopy/contract";
import { type Graph, isRecord } from "@loopy/core";
import { Effect } from "effect";
import { LocalExecutor } from "../../src/executor";
import { activate } from "../../src/host";
import { makeLocalService, Registry } from "../../src/local";
import { openRunStore } from "../../src/store";
import { builtBody } from "./compiled";
import { qualityTestRoot } from "./quality-test-root";

type Project = { cwd: string; home: string };

/** A project directory with its own Loopy home, holding one graph built with the SDK. */
export function fixture(graph: Graph) {
  const root = qualityTestRoot("project");

  return { cwd: root, home: join(root, "home"), file: join(root, `${graph.name}.loopy.ts`), graph };
}

export function object(text: string) {
  const value: unknown = JSON.parse(text);

  if (!isRecord(value)) {
    throw new Error(`CLI output must be an object: ${text}`);
  }

  return value;
}

export async function save(f: ReturnType<typeof fixture>) {
  return saveBody(f, await builtBody(f.graph, { path: f.file, workspace: f.cwd }));
}

/** Saves a body through the local service and returns the registry entry it published. */
export function saveBody(f: Project, body: PutLoopyBody) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* openRunStore(f.home);
        const service = makeLocalService({ store, home: f.home });
        yield* service.putLoopy(body.graph.name, body);
        const registry = yield* Registry.make(f.home, f.cwd);

        return yield* registry.get(body.graph.name);
      }),
    ),
  );
}

/** Starts the saved fixture loopy, activates it to completion and returns its record. */
export async function runFixture(f: Project) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* Registry.make(f.home, f.cwd);
        const saved = (yield* registry.list())[0];

        if (!saved) {
          throw new Error("Save fixture before running it.");
        }

        const store = yield* openRunStore(f.home);
        const service = makeLocalService({ store, home: f.home });
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

        const finished = yield* store.getRun(run.id);

        if (!finished) {
          throw new Error(`Run '${run.id}' disappeared after activation.`);
        }

        return finished;
      }),
    ),
  );
}
