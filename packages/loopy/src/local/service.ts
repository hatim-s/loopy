import { definitionSummary, type GraphRevisionView, graphView } from "../contract/index.js";
import type { Store } from "../core/index.js";
import { errorMessage } from "../core/index.js";
import type { Clock } from "../host/index.js";
import { LoopyService as PortableService, ServiceError } from "../service/index.js";
import { canonicalPath } from "./fs.js";
import { type Registry, RegistryMissingError } from "./registry.js";
import { saveCompiled } from "./save-compiled.js";
import { SecretStore } from "./secrets.js";
import { generateCommand } from "./typegen/generate.js";

export { ServiceError } from "../service/index.js";

function currentDefinition(registry: Registry, slug: string) {
  try {
    return registry.get(slug);
  } catch (error) {
    if (error instanceof RegistryMissingError) {
      return null;
    }

    throw error;
  }
}

export class LoopyService {
  private readonly service: PortableService;

  constructor(
    private readonly options: {
      store: Store;
      registry: (workspace: string) => Registry;
      clock: Clock;
    },
  ) {
    this.service = new PortableService({
      store: options.store,
      clock: options.clock,
      canonicalWorkspace: canonicalPath,
      registry: (workspace) => {
        const registry = options.registry(workspace);

        return {
          workspace: async () => registry.project,
          listSummaries: async () => registry.list().map(definitionSummary),
          summary: async (slug) => {
            const saved = currentDefinition(registry, slug);

            return saved ? definitionSummary(saved) : null;
          },
          get: async (slug) => {
            const saved = currentDefinition(registry, slug);

            if (!saved) {
              throw new ServiceError(
                "not_found",
                `No saved loopy '${slug}'. Use loopy save <file.ts> first.`,
              );
            }

            return saved;
          },
          revisionGraph: (revision) => registry.revisionGraph(revision),
          revisionSource: (slug, revision) => registry.revisionSource(slug, revision),
          save: async (body) => {
            await saveCompiled(registry, body);
          },
        };
      },
      secrets: {
        list: () => this.listSecrets(),
        set: (name, value) => {
          this.putSecret(name, value);
        },
        remove: (name) => {
          this.deleteSecret(name);
        },
      },
      generateTypes: (body) =>
        generateCommand(body.binary, body.path, { name: body.name ?? undefined }),
    });
  }

  graph(slug: string, workspace: string): GraphRevisionView {
    const saved = currentDefinition(this.options.registry(workspace), slug);

    if (!saved) {
      throw new ServiceError(
        "not_found",
        `No saved loopy '${slug}'. Use loopy save <file.ts> first.`,
      );
    }

    return { revision: saved.revision, graph: graphView(saved.graph) };
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

  scheduleOverview = (...args: Parameters<PortableService["scheduleOverview"]>) =>
    this.service.scheduleOverview(...args);
  listSchedules = (...args: Parameters<PortableService["listSchedules"]>) =>
    this.service.listSchedules(...args);
  putSchedule = (...args: Parameters<PortableService["putSchedule"]>) =>
    this.service.putSchedule(...args);
  setScheduleEnabled = (...args: Parameters<PortableService["setScheduleEnabled"]>) =>
    this.service.setScheduleEnabled(...args);
  deleteSchedule = (...args: Parameters<PortableService["deleteSchedule"]>) =>
    this.service.deleteSchedule(...args);
  startRun = (...args: Parameters<PortableService["startRun"]>) => this.service.startRun(...args);
  putLoopy = (...args: Parameters<PortableService["putLoopy"]>) => this.service.putLoopy(...args);
  runGraph = (...args: Parameters<PortableService["runGraph"]>) => this.service.runGraph(...args);
  requireRun = (...args: Parameters<PortableService["requireRun"]>) =>
    this.service.requireRun(...args);
  view = (...args: Parameters<PortableService["view"]>) => this.service.view(...args);
  resumeRun = (...args: Parameters<PortableService["resumeRun"]>) =>
    this.service.resumeRun(...args);
  cancelRun = (...args: Parameters<PortableService["cancelRun"]>) =>
    this.service.cancelRun(...args);
  resolveNamedHook = (...args: Parameters<PortableService["resolveNamedHook"]>) =>
    this.service.resolveNamedHook(...args);
  resolveHook = (...args: Parameters<PortableService["resolveHook"]>) =>
    this.service.resolveHook(...args);
  runSnapshot = (...args: Parameters<PortableService["runSnapshot"]>) =>
    this.service.runSnapshot(...args);
  listRuns = (...args: Parameters<PortableService["listRuns"]>) => this.service.listRuns(...args);
  listLoopies = (...args: Parameters<PortableService["listLoopies"]>) =>
    this.service.listLoopies(...args);
  overview = (...args: Parameters<PortableService["overview"]>) => this.service.overview(...args);
  executions = (...args: Parameters<PortableService["executions"]>) =>
    this.service.executions(...args);
  scopes = (...args: Parameters<PortableService["scopes"]>) => this.service.scopes(...args);
  scopeItems = (...args: Parameters<PortableService["scopeItems"]>) =>
    this.service.scopeItems(...args);
  execution = (...args: Parameters<PortableService["execution"]>) =>
    this.service.execution(...args);
  globalLogs = (...args: Parameters<PortableService["globalLogs"]>) =>
    this.service.globalLogs(...args);
  log = (...args: Parameters<PortableService["log"]>) => this.service.log(...args);
  eventHistory = (...args: Parameters<PortableService["eventHistory"]>) =>
    this.service.eventHistory(...args);
  event = (...args: Parameters<PortableService["event"]>) => this.service.event(...args);
  runSource = (...args: Parameters<PortableService["runSource"]>) =>
    this.service.runSource(...args);
  loopySource = (...args: Parameters<PortableService["loopySource"]>) =>
    this.service.loopySource(...args);
  runPayload = (...args: Parameters<PortableService["runPayload"]>) =>
    this.service.runPayload(...args);
  generateTypes = (...args: Parameters<PortableService["generateTypes"]>) =>
    this.service.generateTypes(...args);
  events = (...args: Parameters<PortableService["events"]>) => this.service.events(...args);
  cursor = (...args: Parameters<PortableService["cursor"]>) => this.service.cursor(...args);
}
