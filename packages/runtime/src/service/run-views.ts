import {
  type LoopyView,
  loopyView,
  type RunView,
  type routes,
  runView,
  serverEvent,
} from "@loopy/contract";
import {
  emptyRunCounts,
  type RunDefinitionCount,
  type RunFilter,
  type RunRecord,
  type RuntimeEvent,
  type StatusCounts,
} from "@loopy/core";
import type { Schema } from "effect";
import { Effect } from "effect";
import { type DefinitionCatalog, makeDefinitionCatalog } from "./definition-catalog";
import { ServiceError } from "./error";
import type { ServiceOptions } from "./registry";
import { nodeEventPreview } from "./views";

function definitionCounts(rows: RunDefinitionCount[]) {
  const projects = new Map<string, Map<string, StatusCounts>>();
  const global = new Map<string, StatusCounts>();

  for (const row of rows) {
    const workspace = projects.get(row.workspace) ?? new Map<string, StatusCounts>();
    projects.set(row.workspace, workspace);
    const counts = workspace.get(row.slug) ?? emptyRunCounts();
    counts[row.status] += row.count;
    workspace.set(row.slug, counts);
    const total = global.get(row.slug) ?? emptyRunCounts();
    total[row.status] += row.count;
    global.set(row.slug, total);
  }

  return { projects, global };
}

export function makeRunViews(options: ServiceOptions) {
  const timestamp = () => {
    return new Date(options.clock.now()).toISOString();
  };

  const view = Effect.fn("run-views.view")(function* (run: RunRecord) {
    return (yield* resolve([run]))(run);
  });

  const resolve = Effect.fn("run-views.resolve")(function* (
    runs: RunRecord[],
    catalog: DefinitionCatalog = makeDefinitionCatalog(options.registry),
  ) {
    const descriptions = new Map<RunRecord, string | null>();

    for (const run of runs) {
      const summary = yield* catalog.summary(run.workspace, run.slug);
      // Runs outlive deleted definitions.
      descriptions.set(run, summary?.description ?? null);
    }

    const ids = runs.map((run) => run.id);
    const now = timestamp();
    const hooks = yield* options.store.pendingHooks(ids, now);

    return (run: RunRecord): RunView =>
      runView({
        run,
        loopy: { slug: run.slug, description: descriptions.get(run) ?? null },
        hook: hooks.get(run.id),
        now,
        leaseMs: options.store.leaseMs,
      });
  });

  const listRuns = Effect.fn("run-views.listRuns")(function* (
    query: Schema.Schema.Type<typeof routes.runs.query>,
  ) {
    const runs = yield* options.store.queryRuns({ ...query, now: timestamp() });
    const resolved = yield* resolve(runs);

    return runs.map(resolved);
  });

  const listLoopies = Effect.fn("run-views.listLoopies")(function* (callerWorkspace = "") {
    const [workspaces, schedules, rows] = yield* Effect.all([
      options.store.runWorkspaces(),
      options.store.listSchedules(),
      options.store.runCountsByDefinition(),
    ]);

    const counts = definitionCounts(rows);
    const views = new Map<string, LoopyView>();
    const catalog: DefinitionCatalog = makeDefinitionCatalog(options.registry);

    // Load each selected registry once before resolving recent runs across workspaces.
    const selected = new Set([
      callerWorkspace,
      ...workspaces,
      ...schedules.map((schedule) => schedule.workspace),
    ]);

    for (const workspace of selected) {
      yield* catalog.list(workspace);
    }

    for (const workspace of selected) {
      const { identity } = yield* catalog.resolve(workspace);

      for (const saved of yield* catalog.list(workspace)) {
        if (views.has(saved.slug)) {
          continue;
        }

        const filter: RunFilter = { slug: saved.slug };

        if (saved.scope !== "global") {
          filter.workspace = identity;
        }

        const recent = yield* options.store.queryRuns({
          ...filter,
          limit: 10,
          now: timestamp(),
        });

        const resolved = yield* resolve(recent, catalog);
        const latestRuns = recent.map(resolved);

        const view = loopyView(
          { ...saved, workspace: identity },
          schedules.find(
            (schedule) => schedule.slug === saved.slug && schedule.workspace === identity,
          ) ?? null,
          [],
        );

        const selectedCounts =
          saved.scope === "global"
            ? counts.global.get(saved.slug)
            : counts.projects.get(identity)?.get(saved.slug);

        views.set(saved.slug, {
          ...view,
          counts: selectedCounts ?? emptyRunCounts(),
          lastRun: latestRuns[0] ?? null,
          latestRuns,
        });
      }
    }

    return [...views.values()];
  });

  const runSnapshot = Effect.fn("run-views.runSnapshot")(function* (id: string) {
    const snapshot = yield* options.store.dashboardSnapshot(id);

    if (!snapshot) {
      return yield* Effect.fail(
        new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`),
      );
    }

    return { ...snapshot, run: yield* view(snapshot.run) };
  });

  const events = Effect.fn("run-views.events")(function* (transaction: RuntimeEvent[]) {
    const runs = transaction.flatMap((event) => (event.entity === "run" ? [event.record] : []));
    const view = yield* resolve(runs);

    return transaction.map((event) =>
      event.entity === "node" ? nodeEventPreview(event) : serverEvent(event, view),
    );
  });

  const cursor = Effect.fn("run-views.cursor")(function* () {
    return yield* options.store.eventCursor();
  });

  return { view, resolve, listRuns, listLoopies, runSnapshot, events, cursor };
}

export type RunViews = ReturnType<typeof makeRunViews>;
