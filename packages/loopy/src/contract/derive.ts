import type { HookRecord, RunRecord, RuntimeEvent, Schedule, StepRecord } from "../core/index.js";
import type { LoopyView, RunView, ServerEvent } from "./views.js";

type RunViewOptions = {
  run: RunRecord;
  loopy: RunView["loopy"];
  steps: StepRecord[];
  hooks: HookRecord[];
  now: string;
  leaseMs: number;
};

function waitingOn({ run, steps, hooks, now }: RunViewOptions): RunView["waitingOn"] {
  if (run.status !== "running" && run.status !== "suspended") {
    return null;
  }

  const latest = steps
    .filter((step) => step.runId === run.id)
    .reduce<StepRecord | null>(
      (last, step) => (last === null || step.seq > last.seq ? step : last),
      null,
    );

  if (latest?.status !== "waiting" || latest.kind !== "hook") {
    return null;
  }

  const hook = hooks.find(
    (item) =>
      item.runId === run.id &&
      item.seq === latest.seq &&
      item.resolvedAt === undefined &&
      item.expiredAt === undefined,
  );

  if (!hook || (latest.wakeAt !== undefined && Date.parse(latest.wakeAt) <= Date.parse(now))) {
    return null;
  }

  return {
    hook: hook.name,
    token: hook.token,
    seq: hook.seq,
    expiresAt: latest.wakeAt ?? null,
    since: hook.createdAt,
  };
}

function outcome(run: RunRecord) {
  switch (run.status) {
    case "succeeded": {
      if (run.output === undefined) {
        throw new Error("Succeeded run has no output. Repair the stored run.");
      }

      return { status: run.status, output: run.output };
    }

    case "failed": {
      if (run.error === undefined) {
        throw new Error("Failed run has no error. Repair the stored run.");
      }

      return { status: run.status, error: run.error };
    }

    case "suspended": {
      return { status: run.status, wakeAt: run.wakeAt ?? null };
    }

    default: {
      return { status: run.status };
    }
  }
}

export function runView(options: RunViewOptions): RunView {
  const { run, now, leaseMs } = options;

  const owner = run.owner
    ? {
        pid: run.owner.pid,
        host: run.owner.host,
        heartbeatAt: run.owner.heartbeatAt,
      }
    : null;

  return {
    id: run.id,
    slug: run.slug,
    workspace: run.workspace,
    loopy: { slug: options.loopy.slug, description: options.loopy.description },
    input: run.input,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    owner,
    ownerStale: owner !== null && Date.parse(now) - Date.parse(owner.heartbeatAt) > leaseMs,
    waitingOn: waitingOn(options),
    ...outcome(run),
  };
}

type SavedLoopyInput = Pick<LoopyView, "slug" | "description" | "scope" | "mode"> & {
  input: Readonly<Exclude<LoopyView["input"], "schema">> | "schema";
};

function scheduleView(schedule: Schedule | null): LoopyView["schedule"] {
  if (schedule === null) {
    return null;
  }

  return {
    cron: schedule.cron,
    tz: schedule.tz,
    enabled: schedule.enabled,
    nextFireAt: schedule.nextFireAt,
  };
}

export function loopyView(
  saved: SavedLoopyInput,
  schedule: Schedule | null,
  runs: RunView[],
): LoopyView {
  const matching = runs.filter((run) => run.slug === saved.slug);

  const counts: LoopyView["counts"] = {
    queued: 0,
    running: 0,
    suspended: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };

  let lastRun: RunView | null = null;

  for (const run of matching) {
    counts[run.status]++;

    if (lastRun === null || run.createdAt > lastRun.createdAt) {
      lastRun = run;
    }
  }

  return {
    slug: saved.slug,
    description: saved.description,
    scope: saved.scope,
    mode: saved.mode,
    input: saved.input,
    schedule: scheduleView(schedule),
    lastRun,
    counts,
  };
}

export function serverEvent(event: RuntimeEvent, view: (run: RunRecord) => RunView): ServerEvent {
  if (event.entity === "run") {
    return { ...event, record: view(event.record) };
  }

  return event;
}
