import type { z } from "zod";
import type { routes } from "../../contract/index.js";
import { SecretStore } from "../secrets.js";
import { generateCommand } from "../typegen/generate.js";
import { ServiceContext, type ServiceOptions } from "./context.js";
import { LoopiesService } from "./loopies.js";
import { RunsService } from "./runs.js";
import { SchedulesService } from "./schedules.js";

export class LoopyService extends ServiceContext {
  readonly startRun;
  readonly requireRun;
  readonly view;
  readonly resumeRun;
  readonly cancelRun;
  readonly resolveNamedHook;
  readonly resolveHook;
  readonly runSnapshot;
  readonly listRuns;
  readonly events;
  readonly cursor;
  readonly listSchedules;
  readonly putSchedule;
  readonly setScheduleEnabled;
  readonly deleteSchedule;
  readonly putLoopy;
  readonly graph;
  readonly listLoopies;
  constructor(options: ServiceOptions) {
    super(options);
    const runs = new RunsService(options);
    const schedules = new SchedulesService(options);
    const loopies = new LoopiesService(options, runs);
    this.startRun = runs.startRun.bind(runs);
    this.requireRun = runs.requireRun.bind(runs);
    this.view = runs.view.bind(runs);
    this.resumeRun = runs.resumeRun.bind(runs);
    this.cancelRun = runs.cancelRun.bind(runs);
    this.resolveNamedHook = runs.resolveNamedHook.bind(runs);
    this.resolveHook = runs.resolveHook.bind(runs);
    this.runSnapshot = runs.runSnapshot.bind(runs);
    this.listRuns = runs.listRuns.bind(runs);
    this.events = runs.events.bind(runs);
    this.cursor = runs.cursor.bind(runs);
    this.listSchedules = schedules.listSchedules.bind(schedules);
    this.putSchedule = schedules.putSchedule.bind(schedules);
    this.setScheduleEnabled = schedules.setScheduleEnabled.bind(schedules);
    this.deleteSchedule = schedules.deleteSchedule.bind(schedules);
    this.putLoopy = loopies.putLoopy.bind(loopies);
    this.graph = loopies.graph.bind(loopies);
    this.listLoopies = loopies.listLoopies.bind(loopies);
  }
  listSecrets() {
    return new SecretStore(this.options.home).list();
  }
  async putSecret(name: string, value: string) {
    await new SecretStore(this.options.home).set(name, value);

    return { name, saved: true as const };
  }
  async deleteSecret(name: string) {
    await new SecretStore(this.options.home).remove(name);

    return { name, removed: true as const };
  }
  generateTypes(body: z.output<typeof routes.generateTypes.body>, workspace: string) {
    return generateCommand(body.binary, body.path, {
      name: body.name,
      workspace,
      home: this.options.home,
    });
  }
}
