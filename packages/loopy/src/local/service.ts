import type { z } from "zod";
import {
  type CursorView,
  encodeRunCursor,
  graphView,
  type Json,
  type LoopyView,
  loopyView,
  type PutLoopyBody,
  type PutScheduleBody,
  type RunView,
  type routes,
  runView,
  type SavedLoopy,
  type ScheduleView,
  serverEvent,
} from "../contract/index.js";
import {
  assertJson,
  assertTimeZone,
  errorMessage,
  matchesRecord,
  nextFire,
  parseCron,
  type RunRecord,
  type RuntimeEvent,
  type Schedule,
  type Store,
  StoreError,
} from "../core/index.js";
import { type Clock } from "../host/index.js";
import { canonicalPath } from "./fs.js";
import type { Registry } from "./registry.js";
import { SecretStore } from "./secrets.js";
import { ServiceError } from "./service-error.js";
import { generateCommand } from "./typegen/generate.js";

export class LoopyService {
  constructor(
    private readonly options: {
      store: Store;
      registry: (workspace: string) => Registry;
      clock: Clock;
    },
  ) {}

  private now() {
    return new Date(this.options.clock.now()).toISOString();
  }

  private scheduleTarget(slug: string, callerWorkspace = "") {
    const registry = this.options.registry(callerWorkspace);
    const saved = registry.list().find((entry) => entry.graph.name === slug);

    if (!saved) {
      throw new ServiceError("not_found");
    }

    return { registry, saved, workspace: registry.project };
  }

  async listSchedules(callerWorkspace = ""): Promise<ScheduleView[]> {
    const workspace = this.options.registry(callerWorkspace).project;

    return (await this.options.store.listSchedules())
      .filter((schedule) => schedule.workspace === workspace)
      .map((schedule) => this.scheduleView(schedule));
  }

  private scheduleView(schedule: Schedule): ScheduleView {
    return { ...schedule, lastFireKey: schedule.lastFireKey ?? null };
  }

  async putSchedule(
    slug: string,
    body: PutScheduleBody,
    callerWorkspace = "",
  ): Promise<ScheduleView> {
    const { saved, workspace } = this.scheduleTarget(slug, callerWorkspace);
    const cron = body.cron ?? saved.graph.meta.schedule?.cron;

    if (cron === undefined) {
      throw new ServiceError(
        "invalid_schedule",
        `No schedule for '${slug}'. Pass --cron or add schedule to loopy().`,
      );
    }

    const tz = body.tz ?? saved.graph.meta.schedule?.tz ?? "UTC";
    this.validateTimezone(tz);
    const nextFireAt = this.scheduleNextFire(cron, tz);
    const input = await this.scheduleInput(saved, body);

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
      assertTimeZone(tz);
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

  private async scheduleInput(saved: SavedLoopy, body: PutScheduleBody) {
    try {
      const input = this.validateInput(saved, body.input === undefined ? {} : body.input);
      assertJson(input, "Schedule input");

      return input;
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  private async requireSchedule(slug: string, callerWorkspace: string): Promise<Schedule> {
    const { workspace } = this.scheduleTarget(slug, callerWorkspace);

    const schedule = (await this.options.store.listSchedules()).find(
      (entry) => entry.workspace === workspace && entry.slug === slug,
    );

    if (!schedule) {
      throw new ServiceError("not_found");
    }

    return schedule;
  }

  async setScheduleEnabled(
    slug: string,
    enabled: boolean,
    callerWorkspace = "",
  ): Promise<ScheduleView> {
    const current = await this.requireSchedule(slug, callerWorkspace);

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

  async deleteSchedule(slug: string, callerWorkspace = ""): Promise<{ deleted: true }> {
    const { workspace } = this.scheduleTarget(slug, callerWorkspace);
    await this.options.store.deleteSchedule(workspace, slug);

    return { deleted: true };
  }

  async startRun(slug: string, input: Json, workspace: string): Promise<RunView> {
    const registry = this.options.registry(workspace);
    const saved = registry.list().find((entry) => entry.graph.name === slug);

    if (!saved) {
      throw new ServiceError("not_found");
    }

    const runId = crypto.randomUUID();
    const validated = this.validateInput(saved, input);
    await this.options.store.createRun({
      id: runId,
      slug,
      input: validated,
      workspace: canonicalPath(workspace),
      revision: saved.revision,
      status: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
    });

    return this.view(await this.requireRun(runId));
  }

  private validateInput(saved: SavedLoopy, input: Json): Json {
    const spec = saved.graph.input;

    if (!matchesRecord(spec, input, { extraKeys: "reject" })) {
      throw new ServiceError("bad_request", "Input does not match the saved graph schema.");
    }

    return input;
  }

  async putLoopy(slug: string, body: PutLoopyBody) {
    if (slug !== body.graph.name) {
      throw new ServiceError("bad_request", "The URL name must match the graph name.");
    }

    await this.options.registry(body.source.workspace).save(body);

    return graphView(body.graph);
  }

  graph(slug: string, workspace: string) {
    return graphView(this.options.registry(workspace).get(slug).graph);
  }

  async requireRun(id: string): Promise<RunRecord> {
    const run = await this.options.store.getRun(id);

    if (!run) {
      throw new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`);
    }

    return run;
  }

  view(run: RunRecord): RunView {
    const saved = this.options
      .registry(run.workspace)
      .list()
      .find((entry) => entry.graph.name === run.slug);

    return this.runView(run, saved);
  }

  private runView(run: RunRecord, saved?: SavedLoopy): RunView {
    return runView({
      run,
      steps: [],
      hooks: [],
      loopy: { slug: run.slug, description: saved?.graph.meta.description ?? null },
      now: this.now(),
      leaseMs: this.options.store.leaseMs,
    });
  }

  private async claim(id: string, token: string) {
    try {
      await this.options.store.claim(id, token);
    } catch (error) {
      if (
        error instanceof StoreError &&
        (error.code === "not_found" ||
          error.code === "owned_elsewhere" ||
          error.code === "not_claimable")
      ) {
        throw new ServiceError(error.code);
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
      await this.options.store.apply({
        runId: id,
        token,
        effects: [{ kind: "finish_run", outcome: { status: "cancelled" }, at: this.now() }],
      });
    } finally {
      await this.options.store.release(id, token);
    }

    return this.view(await this.requireRun(id));
  }

  resolveNamedHook: (id: string, name: string, payload: Json) => Promise<RunView> = async () => {
    throw new ServiceError("not_yet", "Wait signals arrive in PR 4c.");
  };
  resolveHook: (token: string, payload: Json) => Promise<RunView> = async () => {
    throw new ServiceError("not_yet", "Wait signals arrive in PR 4c.");
  };

  async runSnapshot(id: string) {
    const snapshot = await this.options.store.snapshotRun(id);

    if (!snapshot) {
      throw new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`);
    }

    return {
      ...snapshot,
      run: runView({
        ...snapshot,
        loopy: this.view(snapshot.run).loopy,
        now: this.now(),
        leaseMs: this.options.store.leaseMs,
      }),
    };
  }

  async listRuns(query: z.output<typeof routes.runs.query>): Promise<RunView[]> {
    const runs = (await this.options.store.listRuns(query))
      .filter((run) => query.before === undefined || encodeRunCursor(run) < query.before)
      .sort(
        (a, b) =>
          Number(encodeRunCursor(a) < encodeRunCursor(b)) -
          Number(encodeRunCursor(a) > encodeRunCursor(b)),
      );

    const selected = query.waiting === undefined ? runs.slice(0, query.limit) : runs;

    return selected
      .map((run) => this.view(run))
      .filter((run) => query.waiting === undefined || (run.waitingOn !== null) === query.waiting)
      .slice(0, query.limit);
  }

  async listLoopies(callerWorkspace = ""): Promise<LoopyView[]> {
    const [records, schedules] = await Promise.all([
      this.options.store.listRuns(),
      this.options.store.listSchedules(),
    ]);

    const workspaces = new Set([
      callerWorkspace,
      ...records.map((run) => run.workspace),
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
      this.runView(
        run,
        entries.get(run.workspace)?.find((entry) => entry.graph.name === run.slug),
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
        runs.filter((run) => saved.graph.meta.scope === "global" || run.workspace === project),
      ),
    );
  }

  listSecrets() {
    return new SecretStore(this.options.registry("").home).list();
  }

  async putSecret(name: string, value: string) {
    try {
      await new SecretStore(this.options.registry("").home).set(name, value);

      return { name, saved: true as const };
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  async deleteSecret(name: string) {
    try {
      await new SecretStore(this.options.registry("").home).remove(name);

      return { name, removed: true as const };
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  async generateTypes(body: z.output<typeof routes.generateTypes.body>) {
    try {
      return await generateCommand(body.binary, body.path, { name: body.name ?? undefined });
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  async events(transaction: RuntimeEvent[]) {
    return transaction.map((event) => serverEvent(event, (run) => this.view(run)));
  }

  async cursor(): Promise<CursorView> {
    return this.options.store.eventCursor();
  }
}
