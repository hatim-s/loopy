import {
  graphView,
  type LoopyView,
  loopyView,
  type PutLoopyBody,
  type RunView,
  type SavedLoopy,
} from "../../contract/index.js";
import type { Schedule } from "../../core/index.js";
import { ServiceError } from "../service-error.js";
import { ServiceContext, type ServiceOptions } from "./context.js";
import type { RunsService } from "./runs.js";

export class LoopiesService extends ServiceContext {
  constructor(
    options: ServiceOptions,
    private readonly runs: RunsService,
  ) {
    super(options);
  }
  async putLoopy(slug: string, body: PutLoopyBody) {
    if (slug !== body.graph.name) {
      throw new ServiceError("bad_request", "The URL name must match the graph name.");
    }

    await this.options.registry(body.source.workspace).save(body);

    return graphView(body.graph);
  }

  graph(slug: string, workspace: string) {
    return graphView(this.target(slug, workspace).saved.graph);
  }

  async listLoopies(callerWorkspace: string): Promise<LoopyView[]> {
    const [records, schedules] = await Promise.all([
      this.options.store.listRuns(),
      this.options.store.listSchedules(),
    ]);

    const workspaces = new Set([
      callerWorkspace,
      ...records.map((run) => run.projectRoot),
      ...schedules.map((schedule) => schedule.workspace),
    ]);

    const entries = new Map<string, SavedLoopy[]>();

    for (const workspace of workspaces) {
      const registry = this.options.registry(workspace);

      if (!entries.has(registry.project)) {
        entries.set(registry.project, registry.list());
      }
    }

    const runs = records.map((run) =>
      this.runs.project(
        run,
        entries.get(run.projectRoot)?.find((entry) => entry.graph.name === run.slug) ?? null,
      ),
    );

    const views = new Map<string, LoopyView>();

    for (const [project, saved] of entries) {
      for (const view of this.registryViews(project, saved, schedules, runs)) {
        if (!views.has(view.slug)) {
          views.set(view.slug, view);
        }
      }
    }

    return [...views.values()];
  }

  private registryViews(
    project: string,
    entries: SavedLoopy[],
    schedules: Schedule[],
    runs: RunView[],
  ): LoopyView[] {
    return entries.map((saved) =>
      loopyView(
        saved,
        schedules.find((item) => item.slug === saved.graph.name && item.workspace === project) ??
          null,
        runs.filter((run) => saved.graph.meta.scope === "global" || run.projectRoot === project),
      ),
    );
  }
}
