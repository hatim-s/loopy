import {
  emptyRunCounts,
  type LoopyView,
  loopyView,
  type RunDefinitionCount,
  type RunPageQuery,
  type RunView,
  type routes,
  runView,
  type StatusCounts,
  serverEvent,
} from "@loopy/contract";
import type { RunRecord, RuntimeEvent } from "@loopy/core";
import type { Schema } from "effect";
import { Effect } from "effect";
import { runNotFound, type ServiceContext } from "./context";
import { type DefinitionCatalog, makeDefinitionCatalog } from "./definition-catalog";

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

export function makeRunViews(context: ServiceContext) {
  const view = Effect.fn("run-views.view")(function* (run: RunRecord) {
    return (yield* resolve([run]))(run);
  });

  const resolve = Effect.fn("run-views.resolve")(function* (runs: RunRecord[]) {
    const now = context.now();
    const ids = runs.map((run) => run.id);
    const hooks = yield* context.store.pendingHooks(ids, now);

    return (run: RunRecord): RunView =>
      runView({
        run,
        hook: hooks.get(run.id),
        now,
        leaseMs: context.store.leaseMs,
      });
  });

  const listRuns = Effect.fn("run-views.listRuns")(function* (
    query: Schema.Schema.Type<typeof routes.runs.query>,
  ) {
    const runs = yield* context.store.queryRuns({ ...query, now: context.now() });
    const resolved = yield* resolve(runs);

    return runs.map(resolved);
  });

  const listLoopies = Effect.fn("run-views.listLoopies")(function* (callerWorkspace: string) {
    const [workspaces, schedules, rows] = yield* Effect.all([
      context.store.runWorkspaces(),
      context.store.listSchedules(),
      context.store.runCountsByDefinition(),
    ]);

    const counts = definitionCounts(rows);
    const views = new Map<string, LoopyView>();
    const catalog: DefinitionCatalog = makeDefinitionCatalog(context.registry);

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
        // Every workspace lists a global definition; the caller's workspace names it first.
        const key =
          saved.scope === "global" ? `global\0${saved.slug}` : `${identity}\0${saved.slug}`;

        if (views.has(key)) {
          continue;
        }

        const filter: Pick<RunPageQuery, "slug" | "workspace"> = { slug: saved.slug };

        if (saved.scope !== "global") {
          filter.workspace = identity;
        }

        const recent = yield* context.store.queryRuns({ ...filter, limit: 10, now: context.now() });
        const resolved = yield* resolve(recent);

        const selectedCounts =
          saved.scope === "global"
            ? counts.global.get(saved.slug)
            : counts.projects.get(identity)?.get(saved.slug);

        views.set(
          key,
          loopyView(
            { ...saved, workspace: identity },
            schedules.find(
              (schedule) => schedule.slug === saved.slug && schedule.workspace === identity,
            ) ?? null,
            { counts: selectedCounts ?? emptyRunCounts(), latest: recent.map(resolved) },
          ),
        );
      }
    }

    return [...views.values()];
  });

  const runSnapshot = Effect.fn("run-views.runSnapshot")(function* (id: string) {
    const snapshot = yield* context.store.dashboardSnapshot(id);

    if (!snapshot) {
      return yield* runNotFound(id);
    }

    return { ...snapshot, run: yield* view(snapshot.run) };
  });

  const events = Effect.fn("run-views.events")(function* (transaction: RuntimeEvent[]) {
    const runs = transaction.flatMap((event) => (event.entity === "run" ? [event.record] : []));
    const view = yield* resolve(runs);

    return transaction.map((event) => serverEvent(event, view));
  });

  const cursor = Effect.fn("run-views.cursor")(function* () {
    return yield* context.store.eventCursor();
  });

  return { view, resolve, listRuns, listLoopies, runSnapshot, events, cursor };
}

export type RunViews = ReturnType<typeof makeRunViews>;
