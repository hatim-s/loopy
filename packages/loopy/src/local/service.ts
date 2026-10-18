import type { z } from "zod";
import {
  type CursorView,
  DEFAULT_ERROR_MESSAGES,
  type ErrorCode,
  encodeRunCursor,
  graphView,
  isTerminalRun,
  type Json,
  type LoopyView,
  loopyView,
  type PutLoopyBody,
  type PutScheduleBody,
  type RunView,
  type routes,
  runView,
  type ScheduleView,
  serverEvent,
} from "../contract/index.js";
import {
  assertJson,
  errorMessage,
  isFieldValue,
  isRecord,
  nextFire,
  OwnershipError,
  parseCron,
  type RunRecord,
  type RuntimeEvent,
  type Schedule,
  type Store,
} from "../core/index.js";
import { type Clock } from "../host/index.js";
import { canonicalPath } from "./fs.js";
import type { Registry } from "./registry.js";
import { saveCompiled } from "./save-compiled.js";
import type { SavedLoopy } from "./saved-loopy.js";
import { SecretStore } from "./secrets.js";
import { generateCommand } from "./typegen/generate.js";

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
    const saved = registry.list().find((entry) => entry.slug === slug);

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
    const saved = registry.list().find((entry) => entry.slug === slug);

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

    if (spec === "schema" || !isRecord(input)) {
      throw new ServiceError("bad_request", "Graph input requires a record schema and an object.");
    }

    const keys = Object.keys(spec).map((key) => key.replace(/\?$/, ""));

    if (
      Object.keys(input).some((key) => !keys.includes(key)) ||
      Object.entries(spec).some(([field, kind]) => {
        const key = field.replace(/\?$/, "");

        return (
          !(field.endsWith("?") && input[key] === undefined) && !isFieldValue(kind, input[key])
        );
      })
    ) {
      throw new ServiceError("bad_request", "Input does not match the saved graph schema.");
    }

    return input;
  }

  async putLoopy(slug: string, body: PutLoopyBody) {
    if (slug !== body.graph.name) {
      throw new ServiceError("bad_request", "The URL name must match the graph name.");
    }

    try {
      await saveCompiled(this.options.registry(body.source.workspace), body);

      return graphView(body.graph);
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  graph(slug: string, workspace: string) {
    try {
      return graphView(this.options.registry(workspace).get(slug).graph);
    } catch (error) {
      throw new ServiceError("not_found", errorMessage(error));
    }
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
        const [steps, hooks] = await Promise.all([Promise.resolve([]), Promise.resolve([])]);

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
        loopy: this.loopySummary(snapshot.run),
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
    const resolve = await this.viewResolver(selected.map((run) => run.id));

    return selected
      .map(resolve)
      .filter((run) => query.waiting === undefined || (run.waitingOn !== null) === query.waiting)
      .slice(0, query.limit);
  }

  async listLoopies(callerWorkspace = ""): Promise<LoopyView[]> {
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
      callerWorkspace,
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

  listSecrets() {
    return new SecretStore(this.options.registry("").home).list();
  }

  putSecret(name: string, value: string) {
    try {
      new SecretStore(this.options.registry("").home).set(name, value);

      return { name, saved: true as const };
    } catch (error) {
      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  deleteSecret(name: string) {
    try {
      new SecretStore(this.options.registry("").home).remove(name);

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
