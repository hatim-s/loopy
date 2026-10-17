import {
  type CursorView,
  DEFAULT_ERROR_MESSAGES,
  type ErrorCode,
  encodeRunCursor,
  isTerminalRun,
  type Json,
  type LoopyView,
  loopyView,
  type PutScheduleBody,
  type RunsQuery,
  type RunView,
  runView,
  type ScheduleView,
  serverEvent,
} from "../contract/index.js";
import { errorMessage, type RunRecord, type RuntimeEvent, type Schedule } from "../core/index.js";
import { assertJson, type Clock, nextFire, OwnershipError, parseCron } from "../runtime/index.js";
import { createLoopyRun } from "../sdk/host.js";
import { loadLoopy } from "./bundle.js";
import { canonicalPath } from "./fs.js";
import type { Registry } from "./registry.js";
import type { SavedLoopy } from "./saved-loopy.js";
import type { SqliteRunStore } from "./store.js";

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
  constructor(
    private readonly options: {
      store: SqliteRunStore;
      registry: (workspace: string) => Registry;
      clock: Clock;
    },
  ) {}

  private now() {
    return new Date(this.options.clock.now()).toISOString();
  }

  private scheduleTarget(slug: string) {
    const registry = this.options.registry("");
    const saved = registry.list().find((entry) => entry.slug === slug);

    if (!saved) {
      throw new ServiceError("not_found");
    }

    return { registry, saved, workspace: registry.project };
  }

  async listSchedules(): Promise<ScheduleView[]> {
    const workspace = this.options.registry("").project;

    return (await this.options.store.listSchedules())
      .filter((schedule) => schedule.workspace === workspace)
      .map((schedule) => this.scheduleView(schedule));
  }

  private scheduleView(schedule: Schedule): ScheduleView {
    return { ...schedule, lastFireKey: schedule.lastFireKey ?? null };
  }

  async putSchedule(slug: string, body: PutScheduleBody): Promise<ScheduleView> {
    const { registry, saved, workspace } = this.scheduleTarget(slug);
    const loopy = await loadLoopy(registry.bundlePath(saved.bundleHash));
    const cron = body.cron ?? saved.schedule?.cron;

    if (cron === undefined) {
      throw new ServiceError(
        "invalid_schedule",
        `No schedule for '${slug}'. Pass --cron or add schedule to loopy().`,
      );
    }

    const tz = body.tz ?? saved.schedule?.tz ?? "UTC";
    this.validateTimezone(tz);
    const nextFireAt = this.scheduleNextFire(cron, tz);
    const input = await this.scheduleInput(loopy, body);

    return this.scheduleView(
      await this.options.store.putSchedule({
        workspace,
        slug,
        cron,
        tz,
        input,
        enabled: body.enabled ?? true,
        nextFireAt,
      }),
    );
  }

  private validateTimezone(tz: string): void {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
    } catch (error) {
      throw new ServiceError("invalid_timezone", errorMessage(error));
    }
  }

  private scheduleNextFire(cron: string, tz: string) {
    try {
      return nextFire(parseCron(cron), new Date(this.options.clock.now()), tz).toISOString();
    } catch (error) {
      throw new ServiceError("invalid_cron", errorMessage(error));
    }
  }

  private async scheduleInput(loopy: Awaited<ReturnType<typeof loadLoopy>>, body: PutScheduleBody) {
    try {
      const input = await loopy.validateInput(body.input === undefined ? {} : body.input);
      assertJson(input, "Schedule input");

      return input;
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  private async requireSchedule(slug: string): Promise<Schedule> {
    const { workspace } = this.scheduleTarget(slug);

    const schedule = (await this.options.store.listSchedules()).find(
      (entry) => entry.workspace === workspace && entry.slug === slug,
    );

    if (!schedule) {
      throw new ServiceError("not_found");
    }

    return schedule;
  }

  async setScheduleEnabled(slug: string, enabled: boolean): Promise<ScheduleView> {
    const current = await this.requireSchedule(slug);

    const schedule = await this.options.store.setScheduleEnabled({
      workspace: current.workspace,
      slug,
      enabled,
      nextFireAt: enabled
        ? nextFire(
            parseCron(current.cron),
            new Date(this.options.clock.now()),
            current.tz,
          ).toISOString()
        : undefined,
    });

    return this.scheduleView(schedule);
  }

  async deleteSchedule(slug: string): Promise<{ deleted: true }> {
    const { workspace } = this.scheduleTarget(slug);
    await this.options.store.deleteSchedule(workspace, slug);

    return { deleted: true };
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
      throw new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`);
    }

    return run;
  }

  async view(run: RunRecord): Promise<RunView> {
    return (await this.viewResolver([run.id]))(run);
  }

  private async viewResolver(ids: string[], registries = new Map<string, SavedLoopy[]>()) {
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
        loopy: this.loopySummary(run, registries),
        now,
        leaseMs: this.options.store.leaseMs,
      });
    };
  }

  // A run outlives its registry entry, so a deleted loopy leaves the description empty.
  private loopySummary(run: RunRecord, registries = new Map<string, SavedLoopy[]>()) {
    const entries = this.registryEntries(this.options.registry(run.workspace), registries);

    const saved = entries.find((entry) => entry.slug === run.slug);

    return { slug: run.slug, description: saved?.description ?? null };
  }

  private registryEntries(registry: Registry, registries: Map<string, SavedLoopy[]>) {
    let entries = registries.get(registry.project);

    if (!entries) {
      entries = registry.list();
      registries.set(registry.project, entries);
    }

    return entries;
  }

  private async claim(id: string, token: string) {
    const run = await this.requireRun(id);

    if (isTerminalRun(run.status)) {
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

      // Completion can win the race after requireRun but before the store claims ownership.
      const current = await this.options.store.getRun(id);

      if (current && isTerminalRun(current.status)) {
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

  async runSnapshot(id: string) {
    const snapshot = await this.options.store.snapshotRun(id);

    if (!snapshot) {
      throw new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`);
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
      .filter((run) => query.before === undefined || encodeRunCursor(run) < query.before)
      .sort(
        (a, b) =>
          Number(encodeRunCursor(a) < encodeRunCursor(b)) -
          Number(encodeRunCursor(a) > encodeRunCursor(b)),
      );

    const limit = query.limit ?? 50;
    const selected = query.waiting === undefined ? runs.slice(0, limit) : runs;
    const resolve = await this.viewResolver(selected.map((run) => run.id));

    return selected
      .map(resolve)
      .filter((run) => query.waiting === undefined || (run.waitingOn !== null) === query.waiting)
      .slice(0, limit);
  }

  async listLoopies(): Promise<LoopyView[]> {
    const [records, schedules] = await Promise.all([
      this.options.store.listRuns(),
      this.options.store.listSchedules(),
    ]);

    const registries = new Map<string, SavedLoopy[]>();

    const resolve = await this.viewResolver(
      records.map((run) => run.id),
      registries,
    );

    const runs = records.map(resolve);

    const workspaces = new Set([
      "",
      ...runs.map((run) => run.workspace),
      ...schedules.map((schedule) => schedule.workspace),
    ]);

    const views = new Map<string, LoopyView>();

    for (const workspace of workspaces) {
      const registry = this.options.registry(workspace);

      for (const view of this.registryViews(
        registry,
        this.registryEntries(registry, registries),
        schedules,
        runs,
      )) {
        if (!views.has(view.slug)) {
          views.set(view.slug, view);
        }
      }
    }

    return [...views.values()];
  }

  private registryViews(
    registry: Registry,
    entries: SavedLoopy[],
    schedules: Schedule[],
    runs: RunView[],
  ): LoopyView[] {
    return entries.map((saved) =>
      loopyView(
        saved,
        schedules.find((item) => item.slug === saved.slug && item.workspace === registry.project) ??
          null,
        runs.filter((run) => saved.scope === "global" || run.workspace === registry.project),
      ),
    );
  }

  async events(transaction: RuntimeEvent[]) {
    const ids = [
      ...new Set(transaction.flatMap((event) => (event.entity === "run" ? [event.record.id] : []))),
    ];

    const view = await this.viewResolver(ids);

    return transaction.map((event) => serverEvent(event, view));
  }

  async cursor(): Promise<CursorView> {
    return this.options.store.eventCursor();
  }
}
