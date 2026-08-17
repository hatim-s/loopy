import { resolve } from "node:path";
import type { JsonObject } from "@loopy/contracts";
import {
  createSchedule,
  FileScheduleStore,
  fireSchedule,
  installSchedulerArtifacts,
  type LocalSchedule,
  nextFireAt,
  renderSchedulerArtifacts,
  type ScheduleStore,
  tickSchedules,
  uninstallSchedulerArtifacts,
  updateSchedule,
} from "@loopy/platform";
import type { RuntimeScheduler, RuntimeSnapshot } from "@loopy/runtime";
import type { SchedulerEngine } from "@loopy/scheduler";
import type { WorkflowVersionRecord } from "@loopy/storage";

export type { LocalSchedule, ScheduleStore } from "@loopy/platform";

export type ScheduleDependencies = {
  storeFactory?: (projectDir: string) => ScheduleStore;
  store?: ScheduleStore;
  now?: () => Date;
  runtime?: RuntimeScheduler;
  scheduler?: SchedulerEngine;
  waitExecution?: (executionId: string) => Promise<RuntimeSnapshot>;
  workflow?: (workflowId: string, version: number) => WorkflowVersionRecord | undefined;
};

function value(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function positional(args: readonly string[], start = 2): string | undefined {
  const optionsWithValues = new Set([
    "--project",
    "--workflow",
    "--version",
    "--input",
    "--cron",
    "--timezone",
    "--overlap",
    "--missed",
    "--platform",
    "--dir",
    "--executable",
    "--entrypoint",
  ]);
  for (let index = start; index < args.length; index += 1) {
    const item = args[index];
    if (!item || item.startsWith("--")) {
      if (item && optionsWithValues.has(item)) index += 1;
      continue;
    }
    return item;
  }
  return undefined;
}

function project(args: readonly string[]): string {
  return resolve(value(args, "--project") ?? process.cwd());
}

function json(args: readonly string[]): boolean {
  return args.includes("--json");
}

function emit(args: readonly string[], result: unknown, text: string): void {
  console.log(json(args) ? JSON.stringify(result) : text);
}

function storeFor(args: readonly string[], dependencies: ScheduleDependencies): ScheduleStore {
  return (
    dependencies.store ??
    dependencies.storeFactory?.(project(args)) ??
    new FileScheduleStore(project(args))
  );
}

function parseInput(raw: string | undefined): JsonObject {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("schedule --input must be a JSON object");
  return parsed as JsonObject;
}

function requireId(args: readonly string[]): string {
  const id = value(args, "--schedule") ?? positional(args);
  if (!id) throw new Error("schedule command requires a schedule ID");
  return id;
}

function requireSchedule(store: ScheduleStore, id: string): LocalSchedule {
  const schedule = store.get(id);
  if (!schedule) throw new Error(`Unknown schedule '${id}'`);
  return schedule;
}

async function execute(
  request: ReturnType<typeof fireSchedule>,
  dependencies: ScheduleDependencies,
): Promise<RuntimeSnapshot | undefined> {
  if (!dependencies.runtime || !dependencies.workflow) return undefined;
  const workflow = dependencies.workflow(request.workflowId, request.workflowVersion);
  if (!workflow)
    throw new Error(`Unknown workflow version '${request.workflowId}@${request.workflowVersion}'`);
  return dependencies.runtime.run(
    workflow.definition as Parameters<RuntimeScheduler["run"]>[0],
    request.input as JsonObject,
  );
}

export async function scheduleCommand(
  args: readonly string[],
  dependencies: ScheduleDependencies = {},
): Promise<number> {
  const action = args[1] ?? "list";
  const now = dependencies.now?.() ?? new Date();
  const store = storeFor(args, dependencies);
  if (action === "create") {
    const workflowId = value(args, "--workflow");
    const expression = value(args, "--cron");
    if (!workflowId || !expression)
      throw new Error("schedule create requires --workflow and --cron");
    const schedule = createSchedule({
      id: value(args, "--id"),
      name: value(args, "--name"),
      workflowId,
      workflowVersion: Number(value(args, "--version") ?? 1),
      input: parseInput(value(args, "--input")),
      expression,
      timezone: value(args, "--timezone"),
      overlapPolicy: value(args, "--overlap") as LocalSchedule["overlapPolicy"] | undefined,
      missedPolicy: value(args, "--missed") as LocalSchedule["missedPolicy"] | undefined,
      enabled: !args.includes("--disabled"),
      now,
    });
    store.put(schedule);
    emit(args, schedule, `created ${schedule.id} (${schedule.nextFireAt})`);
    return 0;
  }
  if (action === "list") {
    const schedules = store.list();
    emit(
      args,
      schedules,
      schedules
        .map((item) => `${item.id}\t${item.enabled ? "enabled" : "disabled"}\t${item.expression}`)
        .join("\n"),
    );
    return 0;
  }
  if (action === "show") {
    const schedule = requireSchedule(store, requireId(args));
    emit(
      args,
      schedule,
      `${schedule.id}\t${schedule.workflowId}\t${schedule.expression}\t${schedule.timezone}`,
    );
    return 0;
  }
  if (["enable", "disable"].includes(action)) {
    const current = requireSchedule(store, requireId(args));
    const changed = updateSchedule(current, { enabled: action === "enable" }, now);
    store.put(changed);
    emit(args, changed, `${action}d ${changed.id}`);
    return 0;
  }
  if (action === "remove") {
    const id = requireId(args);
    if (!store.remove(id)) throw new Error(`Unknown schedule '${id}'`);
    emit(args, { id, removed: true }, `removed ${id}`);
    return 0;
  }
  if (action === "fire") {
    if (dependencies.scheduler) {
      const decision = await dependencies.scheduler.fire(
        requireId(args),
        parseInput(value(args, "--input")),
        now,
      );
      const run =
        decision.executionId && dependencies.waitExecution
          ? await dependencies.waitExecution(decision.executionId)
          : undefined;
      emit(
        args,
        run ? { decision, run } : decision,
        run
          ? `fired ${requireId(args)} for ${decision.invocation?.workflowId ?? "workflow"} (${run.run.runId})`
          : `fired ${requireId(args)}`,
      );
      return 0;
    }
    const request = fireSchedule(store, requireId(args), now);
    const run = await execute(request, dependencies);
    emit(
      args,
      run ? { request, run } : request,
      run
        ? `fired ${request.scheduleId} for ${request.workflowId} (${run.run.runId})`
        : `fired ${request.scheduleId} for ${request.workflowId}`,
    );
    return 0;
  }
  if (action === "tick") {
    if (dependencies.scheduler) {
      const result = await dependencies.scheduler.tick(now);
      const runs: RuntimeSnapshot[] = [];
      for (const decision of result.decisions) {
        if (decision.executionId && dependencies.waitExecution)
          runs.push(await dependencies.waitExecution(decision.executionId));
      }
      emit(
        args,
        runs.length ? { ...result, runs } : result,
        `started ${runs.length}; decisions ${result.decisions.length}`,
      );
      return 0;
    }
    const result = tickSchedules(store, now);
    const runs = [] as RuntimeSnapshot[];
    for (const request of result.due) {
      const run = await execute(request, dependencies);
      if (run) runs.push(run);
    }
    emit(
      args,
      runs.length ? { ...result, runs } : result,
      `fired ${result.due.length}; skipped ${result.skipped.length}`,
    );
    return 0;
  }
  if (action === "install" || action === "uninstall") {
    const schedule = requireSchedule(store, requireId(args));
    const options = {
      executable: resolve(value(args, "--executable") ?? process.execPath),
      ...(value(args, "--entrypoint")
        ? { entrypoint: resolve(value(args, "--entrypoint") as string) }
        : {}),
      projectDir: project(args),
      platform: value(args, "--platform") ?? process.platform,
      ...(value(args, "--dir") ? { targetDir: resolve(value(args, "--dir") as string) } : {}),
    };
    const artifacts = renderSchedulerArtifacts(schedule, options);
    if (action === "install") installSchedulerArtifacts(artifacts);
    else uninstallSchedulerArtifacts(artifacts);
    emit(
      args,
      { scheduleId: schedule.id, action, artifacts },
      `${action}ed ${schedule.id}: ${artifacts.map((item) => item.path).join(", ")}`,
    );
    return 0;
  }
  throw new Error(`Unknown schedule command '${action}'`);
}

export async function cleanupCommand(
  args: readonly string[],
  storage: { runtime: Record<string, unknown>; schedules?: Record<string, unknown> },
): Promise<number> {
  const action = args[1] ?? "preview";
  const methodName = action === "apply" ? "applyRetention" : "previewRetention";
  const owner = storage.schedules ?? storage.runtime;
  const method = owner[methodName];
  if (typeof method !== "function")
    throw new Error(
      "Retention cleanup is unavailable until the local storage retention adapter is installed",
    );
  const filter = {
    ...(value(args, "--before") ? { before: value(args, "--before") } : {}),
    ...(value(args, "--max-age-days") ? { maxAgeDays: Number(value(args, "--max-age-days")) } : {}),
    ...(value(args, "--max-runs") ? { maxRuns: Number(value(args, "--max-runs")) } : {}),
    ...(value(args, "--batch-size") ? { batchSize: Number(value(args, "--batch-size")) } : {}),
  };
  const result = await (method as (filter: Record<string, unknown>) => unknown).call(owner, filter);
  console.log(json(args) ? JSON.stringify(result) : JSON.stringify(result, null, 2));
  return 0;
}

export { nextFireAt };
