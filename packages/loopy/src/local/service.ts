import type { z } from "zod";
import {
  DEFAULT_ERROR_MESSAGES,
  type ErrorCode,
  type Json,
  type LoopyView,
  loopyView,
  type RunSnapshotView,
  type RunView,
  type runsQuerySchema,
  runView,
} from "../contract/index.js";
import { errorMessage, type RunRecord, type Schedule } from "../core/index.js";
import { type Clock, OwnershipError } from "../runtime/index.js";
import { createLoopyRun } from "../sdk/host.js";
import { loadLoopy } from "./bundle.js";
import { canonicalPath } from "./fs.js";
import type { Registry } from "./registry.js";
import type { SqliteRunStore } from "./store.js";

export type RunsQuery = z.infer<typeof runsQuerySchema>;

export class ServiceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message = DEFAULT_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

export class LoopyService {
  readonly startedAt: string;
  concurrency = 4;

  constructor(
    private readonly options: {
      home: string;
      store: SqliteRunStore;
      registry: (workspace: string) => Registry;
      clock: Clock;
    },
  ) {
    this.startedAt = this.now();
  }

  private now() {
    return new Date(this.options.clock.now()).toISOString();
  }

  async startRun(slug: string, input: Json, workspace: string): Promise<RunView> {
    const registry = this.options.registry(workspace);
    const saved = registry.list().find((entry) => entry.slug === slug);

    if (!saved) {
      throw new ServiceError("not_found");
    }

    const loopy = await loadLoopy(registry.bundlePath(saved.bundleHash));
    const runId = crypto.randomUUID();

    try {
      await createLoopyRun({
        loopy,
        input,
        workspace: canonicalPath(workspace),
        runId,
        bundleHash: saved.bundleHash,
        store: this.options.store,
        clock: this.options.clock,
      });
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }

    return this.view(await this.requireRun(runId));
  }

  async requireRun(id: string): Promise<RunRecord> {
    const run = await this.options.store.getRun(id);

    if (!run) {
      throw new ServiceError("not_found");
    }

    return run;
  }

  async view(run: RunRecord): Promise<RunView> {
    const resolve = await this.viewResolver([run.id]);

    return resolve(run);
  }

  async viewResolver(ids: string[]) {
    const records = await Promise.all(
      ids.map(async (id) => {
        const [steps, hooks] = await Promise.all([
          this.options.store.getSteps(id),
          this.options.store.listHooks(id),
        ]);

        return [id, { steps, hooks }] as const;
      }),
    );

    const snapshots = new Map(records);
    const now = this.now();

    return (run: RunRecord) => {
      const snapshot = snapshots.get(run.id);

      if (!snapshot) {
        throw new ServiceError("not_found");
      }

      return runView({
        ...snapshot,
        run,
        loopy: this.loopySummary(run),
        now,
        leaseMs: this.options.store.leaseMs,
      });
    };
  }

  // A run outlives its registry entry, so a deleted loopy leaves the description empty.
  private loopySummary(run: RunRecord) {
    const saved = this.options
      .registry(run.workspace)
      .list()
      .find((entry) => entry.slug === run.slug);

    return { slug: run.slug, description: saved?.description ?? null };
  }

  private async claim(id: string, token: string) {
    const run = await this.requireRun(id);

    if (run.status !== "queued" && run.status !== "suspended" && run.status !== "running") {
      throw new ServiceError("not_claimable");
    }

    try {
      await this.options.store.claim(id, token);
    } catch (error) {
      if (error instanceof OwnershipError) {
        throw new ServiceError(
          "owned_elsewhere",
          `Run '${id}' is owned by PID ${run.owner?.pid} on ${run.owner?.host}. Stop its runner before retrying.`,
        );
      }

      const current = await this.requireRun(id);

      if (
        current.status !== "queued" &&
        current.status !== "suspended" &&
        current.status !== "running"
      ) {
        throw new ServiceError("not_claimable");
      }

      throw error;
    }
  }

  async resumeRun(id: string): Promise<RunView> {
    const code = await this.options.store.wakeRun(id, this.now());

    if (code) {
      throw new ServiceError(code);
    }

    return this.view(await this.requireRun(id));
  }

  async cancelRun(id: string): Promise<RunView> {
    const token = crypto.randomUUID();
    await this.claim(id, token);

    try {
      await this.options.store.finishRun(id, token, { status: "cancelled" });
    } finally {
      await this.options.store.release(id, token);
    }

    return this.view(await this.requireRun(id));
  }

  async resolveNamedHook(id: string, name: string, payload: Json): Promise<RunView> {
    const snapshot = await this.runSnapshot(id);

    if (!snapshot) {
      throw new ServiceError("not_found");
    }

    const waiting = new Set(
      snapshot.steps.filter((step) => step.status === "waiting").map((step) => step.seq),
    );

    const hook = snapshot.hooks
      .reverse()
      .find((item) => item.name === name && item.resolvedAt === undefined && waiting.has(item.seq));

    if (!hook) {
      throw new ServiceError(
        "unknown_hook",
        `Hook '${name}' is not waiting in run '${id}'. Run loopy inspect ${id} to find waiting hooks.`,
      );
    }

    return this.resolveHook(hook.token, payload);
  }

  async resolveHook(token: string, payload: Json): Promise<RunView> {
    const hook = await this.options.store.hook(token);

    if (!hook || !(await this.options.store.resolveHook(token, payload))) {
      throw new ServiceError("unknown_hook");
    }

    return this.view(await this.requireRun(hook.runId));
  }

  async runSnapshot(id: string): Promise<RunSnapshotView | undefined> {
    const snapshot = await this.options.store.snapshotRun(id);

    if (!snapshot) {
      return undefined;
    }

    return {
      ...snapshot,
      run: runView({
        ...snapshot,
        loopy: this.loopySummary(snapshot.run),
        now: this.now(),
        leaseMs: this.options.store.leaseMs,
      }),
    };
  }

  async listRuns(query: RunsQuery): Promise<RunView[]> {
    const runs = (await this.options.store.listRuns(query))
      .filter((run) => !query.before || run.createdAt < query.before)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return Promise.all(
      runs.slice(0, Math.min(query.limit ?? 50, 200)).map((run) => this.view(run)),
    );
  }

  async listLoopies(): Promise<LoopyView[]> {
    const [records, schedules] = await Promise.all([
      this.options.store.listRuns(),
      this.options.store.listSchedules(),
    ]);

    const runs = await Promise.all(records.map((run) => this.view(run)));

    const workspaces = new Set([
      "",
      ...runs.map((run) => run.workspace),
      ...schedules.map((schedule) => schedule.workspace),
    ]);

    const views = new Map<string, LoopyView>();

    for (const workspace of workspaces) {
      const registry = this.options.registry(workspace);

      for (const view of this.registryViews(registry, schedules, runs)) {
        if (!views.has(view.slug)) {
          views.set(view.slug, view);
        }
      }
    }

    return [...views.values()];
  }

  private registryViews(registry: Registry, schedules: Schedule[], runs: RunView[]): LoopyView[] {
    return registry.list().map((saved) =>
      loopyView(
        saved,
        schedules.find(
          (item) =>
            item.slug === saved.slug &&
            (saved.scope === "global" || item.workspace === registry.project),
        ) ?? null,
        runs.filter((run) => saved.scope === "global" || run.workspace === registry.project),
      ),
    );
  }

  async daemon() {
    return {
      pid: process.pid,
      startedAt: this.startedAt,
      concurrency: this.concurrency,
      running: (await this.options.store.listRuns({ status: "running" })).length,
      nextWakeAt: (await this.options.store.nextWakeAt()) ?? null,
    };
  }
}
