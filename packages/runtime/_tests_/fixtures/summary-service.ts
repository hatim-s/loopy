import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type RunRecord, revision } from "@loopy/core";
import { Effect } from "effect";
import { runIn } from "../../../core/_tests_/fixtures/run";
import { Registry } from "../../src/local/registry";
import { makeArtifactRegistry } from "../../src/local/save-compiled";
import { type ArtifactRegistry, makeService, RegistryError } from "../../src/service";
import { compiledBody } from "./compiled";
import { qualityTestRoot } from "./quality-test-root";
import { MemorySqlStore } from "./stores";

export class SummaryCountsStore extends MemorySqlStore {
  groupedReads = 0;

  override runCountsByDefinition() {
    // Lists must group counts once instead of querying once per definition.
    this.groupedReads++;

    return super.runCountsByDefinition();
  }
}

export async function summaryServiceFixture() {
  const directory = qualityTestRoot("summary-service");
  const home = join(directory, "home");
  const a = join(directory, "a");
  const b = join(directory, "b");

  for (const path of [a, b]) {
    mkdirSync(join(path, ".loopy", "loopies"), { recursive: true });
  }

  const graphs: string[] = [];

  const calls = {
    lists: new Map<string, number>(),
    summaries: new Map<string, number>(),
    graphs,
  };

  const store = new SummaryCountsStore();

  const registries = new Map<string, Registry>();

  for (const workspace of [a, b]) {
    registries.set(workspace, await Effect.runPromise(Registry.make(home, workspace)));
  }

  // Runs may record a workspace by a name that canonicalizes to project a.
  const aliases = new Map([
    ["", a],
    ["alias", a],
  ]);

  const registry = (workspace: string) => registries.get(aliases.get(workspace) ?? workspace)!;

  const adapter = (workspace: string): Effect.Effect<ArtifactRegistry> => {
    const native = registry(workspace);
    const base = makeArtifactRegistry(native);

    return Effect.succeed({
      ...base,
      listSummaries: () =>
        Effect.sync(() => {
          calls.lists.set(native.project, (calls.lists.get(native.project) ?? 0) + 1);
        }).pipe(Effect.andThen(base.listSummaries())),
      summary: (slug) =>
        Effect.sync(() => {
          const key = JSON.stringify([native.project, slug]);
          calls.summaries.set(key, (calls.summaries.get(key) ?? 0) + 1);
        }).pipe(Effect.andThen(base.summary(slug))),
      get: (slug) =>
        Effect.suspend(() => {
          calls.graphs.push(slug);

          return slug === "corrupt"
            ? Effect.fail(
                new RegistryError({
                  operation: "read",
                  cause: new Error("Stored graph is corrupt."),
                }),
              )
            : base.get(slug);
        }),
    });
  };

  const service = makeService({
    store,
    registry: adapter,
    clock: { now: () => Date.parse("2026-10-23T00:00:00.000Z") },
    canonicalWorkspace: (workspace) => Effect.succeed(registry(workspace).project),
    secrets: { list: () => Effect.succeed([]), set: () => Effect.void, remove: () => Effect.void },
    generateTypes: () => Effect.die(new Error("Unused fixture operation.")),
  });

  const save = async (workspace: string, slug: string, scope: "global" | "project" = "project") => {
    const body = await compiledBody(slug, join(workspace, `${slug}.ts`), {
      workspace,
      scope,
      description: `${workspace}:${slug}`,
    });

    body.graph.inputValidation = { root: "json", minItems: {}, unknownKeys: "reject" };
    body.revision = await revision(body.graph);

    return Effect.runPromise(registry(workspace).save(body));
  };

  const run = async (id: string, workspace: string, slug: string, status: RunRecord["status"]) => {
    const at = "2026-10-23T00:00:00.000Z";

    const record = runIn(status, {
      id,
      workspace,
      slug,
      revision: "a".repeat(64),
      input: {},
      createdAt: at,
      updatedAt: at,
    });

    await Effect.runPromise(store.createRun(record));

    return record;
  };

  return {
    a,
    b,
    home,
    store,
    service,
    calls,
    save,
    run,
    registry,
  };
}
