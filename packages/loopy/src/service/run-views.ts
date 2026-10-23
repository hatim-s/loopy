import type { z } from "zod";
import {
  type CursorView,
  type LoopyView,
  loopyView,
  type RunView,
  type routes,
  runView,
  serverEvent,
} from "../contract/index.js";
import {
  emptyRunCounts,
  type RunDefinitionCount,
  type RunFilter,
  type RunRecord,
  type RuntimeEvent,
  type StatusCounts,
} from "../core/index.js";
import { DefinitionCatalog } from "./definition-catalog.js";
import { ServiceError } from "./error.js";
import type { ServiceOptions } from "./registry.js";
import { nodeEventPreview } from "./views.js";

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

export class ServiceRunViews {
  constructor(private readonly options: ServiceOptions) {}

  private now() {
    return new Date(this.options.clock.now()).toISOString();
  }

  async view(run: RunRecord): Promise<RunView> {
    return (await this.resolve([run]))(run);
  }

  async resolve(runs: RunRecord[], catalog = new DefinitionCatalog(this.options.registry)) {
    const descriptions = new Map<RunRecord, string | null>();

    for (const run of runs) {
      const summary = await catalog.summary(run.workspace, run.slug);
      // Runs outlive deleted definitions.
      descriptions.set(run, summary?.description ?? null);
    }

    const ids = runs.map((run) => run.id);
    const now = this.now();
    const hooks = await this.options.store.pendingHooks(ids, now);

    return (run: RunRecord): RunView => {
      const view = runView({
        run,
        loopy: { slug: run.slug, description: descriptions.get(run) ?? null },
        steps: [],
        hooks: [],
        now,
        leaseMs: this.options.store.leaseMs,
      });

      const hook = hooks.get(run.id);

      return hook
        ? {
            ...view,
            waitingOn: {
              hook: hook.name,
              token: hook.token,
              seq: hook.seq,
              expiresAt: hook.expiresAt,
              since: hook.createdAt,
            },
          }
        : view;
    };
  }

  async listRuns(query: z.output<typeof routes.runs.query>): Promise<RunView[]> {
    const runs = await this.options.store.queryRuns({ ...query, now: this.now() });
    const resolve = await this.resolve(runs);

    return runs.map(resolve);
  }

  async listLoopies(callerWorkspace = ""): Promise<LoopyView[]> {
    const [workspaces, schedules, rows] = await Promise.all([
      this.options.store.runWorkspaces(),
      this.options.store.listSchedules(),
      this.options.store.runCountsByDefinition(),
    ]);

    const counts = definitionCounts(rows);
    const views = new Map<string, LoopyView>();
    const catalog = new DefinitionCatalog(this.options.registry);

    // Load each selected registry once before resolving recent runs across workspaces.
    const selected = new Set([
      callerWorkspace,
      ...workspaces,
      ...schedules.map((schedule) => schedule.workspace),
    ]);

    for (const workspace of selected) {
      await catalog.list(workspace);
    }

    for (const workspace of selected) {
      const { identity } = await catalog.resolve(workspace);

      for (const saved of await catalog.list(workspace)) {
        if (views.has(saved.slug)) {
          continue;
        }

        const filter: RunFilter = { slug: saved.slug };

        if (saved.scope !== "global") {
          filter.workspace = identity;
        }

        const recent = await this.options.store.queryRuns({
          ...filter,
          limit: 10,
          now: this.now(),
        });

        const resolve = await this.resolve(recent, catalog);
        const latestRuns = recent.map(resolve);

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
  }

  async runSnapshot(id: string) {
    const snapshot = await this.options.store.dashboardSnapshot(id);

    if (!snapshot) {
      throw new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`);
    }

    return { ...snapshot, run: await this.view(snapshot.run) };
  }

  async events(transaction: RuntimeEvent[]) {
    const runs = transaction.flatMap((event) => (event.entity === "run" ? [event.record] : []));
    const view = await this.resolve(runs);

    return transaction.map((event) =>
      event.entity === "node" ? nodeEventPreview(event) : serverEvent(event, view),
    );
  }

  async cursor(): Promise<CursorView> {
    return this.options.store.eventCursor();
  }
}
