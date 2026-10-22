import { existsSync } from "node:fs";
import type { z } from "zod";
import {
  type CursorView,
  DEFAULT_ERROR_MESSAGES,
  type ErrorCode,
  type GraphRevisionView,
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
  type ScheduleOverviewView,
  type ScheduleView,
  type SourceArtifact,
  serverEvent,
} from "../contract/index.js";
import {
  assertJson,
  errorMessage,
  nextFire,
  OwnershipError,
  parseCron,
  type RunFilter,
  type RunRecord,
  type RuntimeEvent,
  type Schedule,
  type Store,
  type StoreEffect,
  validateGraphInput,
} from "../core/index.js";
import { type Clock } from "../host/index.js";
import { canonicalPath } from "./fs.js";
import type { Registry } from "./registry.js";
import { saveCompiled } from "./save-compiled.js";
import type { SavedLoopy } from "./saved-loopy.js";
import { SecretStore } from "./secrets.js";

import { nodeDetailEvent, nodeEventPreview } from "./service-views.js";
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

  async scheduleOverview(): Promise<ScheduleOverviewView> {
    return this.options.store.scheduleOverview();
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
    const result = validateGraphInput(saved.graph, input);

    if (!result.ok) {
      throw new ServiceError("bad_request", result.error);
    }

    return result.value;
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

  graph(slug: string, workspace: string): GraphRevisionView {
    try {
      const saved = this.options.registry(workspace).get(slug);

      return { revision: saved.revision, graph: graphView(saved.graph) };
    } catch (error) {
      throw new ServiceError("not_found", errorMessage(error));
    }
  }

  /** The graph a run executes is the revision it pinned, not the loopy's latest save. */
  async runGraph(id: string): Promise<GraphRevisionView> {
    const run = await this.requireRun(id);
    const registry = this.options.registry(run.workspace);

    if (!existsSync(registry.graphPath(run.revision))) {
      throw new ServiceError(
        "not_found",
        `Graph revision ${run.revision} for run '${id}' is missing from the Loopy home.`,
      );
    }

    return { revision: run.revision, graph: graphView(await registry.revisionGraph(run.revision)) };
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
    const now = this.now();
    const hooks = await this.options.store.pendingHooks(ids, now);

    return (run: RunRecord): RunView => {
      const view = runView({
        run,
        loopy: this.loopySummary(run, registries),
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

  private async cancellableNodes(id: string) {
    const nodes = await this.options.store.getNodeRuns(id);

    if (nodes.some((node) => node.status === "running")) {
      throw new ServiceError(
        "not_claimable",
        "This run has an unfinished execution. Resume it before cancelling.",
      );
    }

    if (nodes.length > 0) {
      const { graph } = await this.runGraph(id);

      if (graph.nodes.some((node) => node.kind === "finally")) {
        throw new ServiceError(
          "not_claimable",
          "This run requires finally cleanup. Cancellation with cleanup is not available; resume the run instead.",
        );
      }
    }

    return nodes;
  }

  async cancelRun(id: string): Promise<RunView> {
    const run = await this.requireRun(id);

    if (isTerminalRun(run.status)) {
      throw new ServiceError("not_claimable");
    }

    await this.cancellableNodes(id);
    const token = crypto.randomUUID();
    await this.claim(id, token);

    try {
      const nodes = await this.cancellableNodes(id);

      const at = this.now();

      const effects: StoreEffect[] = nodes.flatMap((node) =>
        node.status === "waiting" ||
        node.status === "sleeping" ||
        node.status === "retrying" ||
        node.status === "rate_limited" ||
        node.status === "queued"
          ? [
              {
                kind: "write_node_run" as const,
                nodeRun: {
                  key: node.key,
                  attempt: node.attempt,
                  maxAttempts: node.maxAttempts,
                  startedAt: node.startedAt,
                  receipt: node.receipt,
                  status: "cancelled" as const,
                  endedAt: at,
                },
              },
            ]
          : [],
      );

      effects.push({ kind: "finish_run", outcome: { status: "cancelled" }, at });
      await this.options.store.apply({ runId: id, token, effects });
    } finally {
      await this.options.store.release(id, token);
    }

    return this.view(await this.requireRun(id));
  }

  async resolveNamedHook(id: string, name: string, payload: Json): Promise<RunView> {
    await this.requireRun(id);

    const waits = (await this.options.store.getWaits(id)).filter(
      (wait) => wait.name === name && !wait.resolvedAt && !wait.expiredAt,
    );

    if (waits.length > 1) {
      throw new ServiceError(
        "bad_request",
        "More than one pending wait has this name. Resolve a specific hook token.",
      );
    }

    const wait = waits[0];

    if (!wait) {
      throw new ServiceError("unknown_hook");
    }

    return this.resolveHook(wait.token, payload);
  }

  async resolveHook(token: string, payload: Json): Promise<RunView> {
    const result = await this.options.store.resolveWait({ token, payload, at: this.now() });

    if (result.kind === "rejected") {
      throw new ServiceError(result.code, result.message);
    }

    return this.view(await this.requireRun(result.runId));
  }

  async runSnapshot(id: string) {
    const snapshot = await this.options.store.dashboardSnapshot(id);

    if (!snapshot) {
      throw new ServiceError("not_found", `No run '${id}'. Use loopy runs to list run ids.`);
    }

    return { ...snapshot, run: await this.view(snapshot.run) };
  }

  async listRuns(query: z.output<typeof routes.runs.query>): Promise<RunView[]> {
    const runs = await this.options.store.queryRuns({ ...query, now: this.now() });
    const resolve = await this.viewResolver(runs.map((run) => run.id));

    return runs.map(resolve);
  }

  async listLoopies(callerWorkspace = ""): Promise<LoopyView[]> {
    const [workspaces, schedules] = await Promise.all([
      this.options.store.runWorkspaces(),
      this.options.store.listSchedules(),
    ]);

    const views = new Map<string, LoopyView>();
    const registries = new Map<string, SavedLoopy[]>();

    for (const workspace of new Set([
      callerWorkspace,
      ...workspaces,
      ...schedules.map((schedule) => schedule.workspace),
    ])) {
      const registry = this.options.registry(workspace);

      for (const saved of this.registryEntries(registry, registries)) {
        if (views.has(saved.slug)) {
          continue;
        }

        const filter: RunFilter = { slug: saved.slug };

        if (saved.scope !== "global") {
          filter.workspace = registry.project;
        }

        const [counts, recent] = await Promise.all([
          this.options.store.runCounts(filter),
          this.options.store.queryRuns({ ...filter, limit: 10, now: this.now() }),
        ]);

        const resolve = await this.viewResolver(
          recent.map((run) => run.id),
          registries,
        );

        const latestRuns = recent.map(resolve);

        const view = loopyView(
          {
            ...saved,
            workspace: registry.project,
            input: saved.graph.inputValidation?.root === "json" ? "schema" : saved.input,
          },
          schedules.find(
            (schedule) => schedule.slug === saved.slug && schedule.workspace === registry.project,
          ) ?? null,
          [],
        );

        views.set(saved.slug, { ...view, counts, lastRun: latestRuns[0] ?? null, latestRuns });
      }
    }

    return [...views.values()];
  }

  private async readRunReference(id: string) {
    const run = await this.options.store.runReference(id);

    if (!run) {
      throw new ServiceError("not_found");
    }

    return run;
  }

  async overview(query: z.output<typeof routes.overview.query>) {
    return this.options.store.overview(query);
  }
  async executions(id: string, query: z.output<typeof routes.executions.query>) {
    await this.readRunReference(id);

    return this.options.store.nodePage(id, query);
  }
  async scopes(id: string, query: z.output<typeof routes.scopes.query>) {
    await this.readRunReference(id);

    return this.options.store.scopeCounts(id, query.parentScope);
  }
  async scopeItems(id: string, query: z.output<typeof routes.scopeItems.query>) {
    await this.readRunReference(id);

    return this.options.store.scopeItems(id, query);
  }
  async execution(id: string, query: z.output<typeof routes.execution.query>) {
    await this.readRunReference(id);
    const detail = await this.options.store.execution(id, query.key, query.attemptsAfter);

    if (!detail) {
      throw new ServiceError("not_found");
    }

    return detail;
  }
  async globalLogs(query: z.output<typeof routes.globalLogs.query>) {
    return this.options.store.logPage(query);
  }
  async log(id: number) {
    const log = await this.options.store.logDetail(id);

    if (!log) {
      throw new ServiceError("not_found");
    }

    return log;
  }
  async eventHistory(query: z.output<typeof routes.eventHistory.query>) {
    return this.options.store.eventPage(query);
  }
  async event(sequence: number) {
    const event = await this.options.store.eventDetail(sequence);

    if (!event) {
      throw new ServiceError("not_found");
    }

    if (event.entity === "node") {
      return nodeDetailEvent(event);
    }

    return serverEvent(
      event,
      await this.viewResolver(event.entity === "run" ? [event.record.id] : []),
    );
  }
  async runSource(id: string): Promise<SourceArtifact> {
    const run = await this.readRunReference(id);

    return this.options.registry(run.workspace).revisionSource(run.slug, run.revision);
  }
  async loopySource(slug: string, workspace: string): Promise<SourceArtifact> {
    const registry = this.options.registry(workspace);
    let saved: SavedLoopy;

    try {
      saved = registry.get(slug);
    } catch {
      throw new ServiceError("not_found");
    }

    return registry.revisionSource(slug, saved.revision);
  }
  async runPayload(id: string) {
    const run = await this.requireRun(id);

    const payload: z.output<typeof routes.runPayload.response> = { input: run.input };

    if (run.output !== undefined) {
      payload.output = run.output;
    }

    return payload;
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

    return transaction.map((event) => {
      if (event.entity === "node") {
        return nodeEventPreview(event);
      }

      return serverEvent(event, view);
    });
  }

  async cursor(): Promise<CursorView> {
    return this.options.store.eventCursor();
  }
}
