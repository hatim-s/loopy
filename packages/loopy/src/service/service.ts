import type { z } from "zod";
import {
  type GraphRevisionView,
  graphView,
  type Json,
  type PutLoopyBody,
  type RunView,
  type routes,
} from "../contract/index.js";
import { errorMessage, type RunRecord } from "../core/index.js";
import { ServiceError } from "./error.js";
import { validateDefinitionInput } from "./input.js";
import { ServiceMutations } from "./mutations.js";
import { ServiceQueries } from "./queries.js";
import type { ServiceOptions } from "./registry.js";
import { ServiceRunViews } from "./run-views.js";
import { ServiceSchedules } from "./schedules.js";

export class LoopyService {
  private readonly runViews: ServiceRunViews;
  private readonly schedules: ServiceSchedules;
  private readonly queries: ServiceQueries;
  private readonly mutations: ServiceMutations;

  constructor(private readonly options: ServiceOptions) {
    this.runViews = new ServiceRunViews(options);
    this.schedules = new ServiceSchedules(options);
    this.queries = new ServiceQueries(options, this.runViews);
    this.mutations = new ServiceMutations(options, this);
  }

  private now() {
    return new Date(this.options.clock.now()).toISOString();
  }

  async startRun(slug: string, input: Json, workspace: string): Promise<RunView> {
    const registry = this.options.registry(workspace);
    const saved = await registry.get(slug);

    const runId = crypto.randomUUID();
    const validated = validateDefinitionInput(saved, input);
    await this.options.store.createRun({
      id: runId,
      slug,
      input: validated,
      workspace: await this.options.canonicalWorkspace(workspace),
      revision: saved.revision,
      status: "queued",
      createdAt: this.now(),
      updatedAt: this.now(),
    });

    return this.view(await this.requireRun(runId));
  }

  async putLoopy(slug: string, body: PutLoopyBody) {
    if (slug !== body.graph.name) {
      throw new ServiceError("bad_request", "The URL name must match the graph name.");
    }

    try {
      await this.options.registry(body.source.workspace).save(body);

      return graphView(body.graph);
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }

      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  async graph(slug: string, workspace: string): Promise<GraphRevisionView> {
    const saved = await this.options.registry(workspace).get(slug);

    return { revision: saved.revision, graph: graphView(saved.graph) };
  }

  /** The graph a run executes is the revision it pinned, not the loopy's latest save. */
  async runGraph(id: string): Promise<GraphRevisionView> {
    const run = await this.requireRun(id);
    const registry = this.options.registry(run.workspace);

    try {
      return {
        revision: run.revision,
        graph: graphView(await registry.revisionGraph(run.revision)),
      };
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
    return this.runViews.view(run);
  }

  async runPayload(id: string) {
    const run = await this.requireRun(id);

    const payload: z.output<typeof routes.runPayload.response> = { input: run.input };

    if (run.output !== undefined) {
      payload.output = run.output;
    }

    return payload;
  }

  async listSecrets() {
    return this.options.secrets.list();
  }

  async putSecret(name: string, value: string) {
    try {
      await this.options.secrets.set(name, value);

      return { name, saved: true as const };
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }

      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  async deleteSecret(name: string) {
    try {
      await this.options.secrets.remove(name);

      return { name, removed: true as const };
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }

      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  async generateTypes(body: z.output<typeof routes.generateTypes.body>) {
    try {
      return await this.options.generateTypes(body);
    } catch (error) {
      if (error instanceof ServiceError) {
        throw error;
      }

      throw new ServiceError("bad_request", errorMessage(error));
    }
  }

  scheduleOverview = (...args: Parameters<ServiceSchedules["scheduleOverview"]>) =>
    this.schedules.scheduleOverview(...args);
  listSchedules = (...args: Parameters<ServiceSchedules["listSchedules"]>) =>
    this.schedules.listSchedules(...args);
  putSchedule = (...args: Parameters<ServiceSchedules["putSchedule"]>) =>
    this.schedules.putSchedule(...args);
  setScheduleEnabled = (...args: Parameters<ServiceSchedules["setScheduleEnabled"]>) =>
    this.schedules.setScheduleEnabled(...args);
  deleteSchedule = (...args: Parameters<ServiceSchedules["deleteSchedule"]>) =>
    this.schedules.deleteSchedule(...args);
  listRuns = (...args: Parameters<ServiceRunViews["listRuns"]>) => this.runViews.listRuns(...args);
  listLoopies = (...args: Parameters<ServiceRunViews["listLoopies"]>) =>
    this.runViews.listLoopies(...args);
  runSnapshot = (...args: Parameters<ServiceRunViews["runSnapshot"]>) =>
    this.runViews.runSnapshot(...args);
  events = (...args: Parameters<ServiceRunViews["events"]>) => this.runViews.events(...args);
  cursor = (...args: Parameters<ServiceRunViews["cursor"]>) => this.runViews.cursor(...args);
  overview = (...args: Parameters<ServiceQueries["overview"]>) => this.queries.overview(...args);
  executions = (...args: Parameters<ServiceQueries["executions"]>) =>
    this.queries.executions(...args);
  scopes = (...args: Parameters<ServiceQueries["scopes"]>) => this.queries.scopes(...args);
  scopeItems = (...args: Parameters<ServiceQueries["scopeItems"]>) =>
    this.queries.scopeItems(...args);
  execution = (...args: Parameters<ServiceQueries["execution"]>) => this.queries.execution(...args);
  globalLogs = (...args: Parameters<ServiceQueries["globalLogs"]>) =>
    this.queries.globalLogs(...args);
  log = (...args: Parameters<ServiceQueries["log"]>) => this.queries.log(...args);
  eventHistory = (...args: Parameters<ServiceQueries["eventHistory"]>) =>
    this.queries.eventHistory(...args);
  event = (...args: Parameters<ServiceQueries["event"]>) => this.queries.event(...args);
  runSource = (...args: Parameters<ServiceQueries["runSource"]>) => this.queries.runSource(...args);
  loopySource = (...args: Parameters<ServiceQueries["loopySource"]>) =>
    this.queries.loopySource(...args);
  resumeRun = (...args: Parameters<ServiceMutations["resumeRun"]>) =>
    this.mutations.resumeRun(...args);
  cancelRun = (...args: Parameters<ServiceMutations["cancelRun"]>) =>
    this.mutations.cancelRun(...args);
  resolveNamedHook = (...args: Parameters<ServiceMutations["resolveNamedHook"]>) =>
    this.mutations.resolveNamedHook(...args);
  resolveHook = (...args: Parameters<ServiceMutations["resolveHook"]>) =>
    this.mutations.resolveHook(...args);
}
