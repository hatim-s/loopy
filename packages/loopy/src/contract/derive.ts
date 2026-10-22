import type {
  Graph as CoreGraph,
  HookRecord,
  RunRecord,
  RuntimeEvent,
  Schedule,
  StepRecord,
} from "../core/index.js";
import type { GraphView } from "./graph.js";
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

function previewPayload(value: RunRecord["input"]): {
  value: RunRecord["input"];
  bytes: number | null;
} {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;

  return bytes > 16_384 ? { value: null, bytes } : { value, bytes: null };
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

  const input = previewPayload(run.input);
  const result = outcome(run);
  const output = result.status === "succeeded" ? previewPayload(result.output) : null;

  const truncatedFields: NonNullable<RunRecord["truncatedFields"]> = { ...run.truncatedFields };

  if (input.bytes !== null) {
    truncatedFields.input = input.bytes;
  }

  if (output?.bytes) {
    truncatedFields.output = output.bytes;
  }

  if (result.status === "succeeded" && output) {
    result.output = output.value;
  }

  const view: RunView = {
    id: run.id,
    slug: run.slug,
    workspace: run.workspace,
    loopy: { slug: options.loopy.slug, description: options.loopy.description },
    input: input.value,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    owner,
    ownerStale: owner !== null && Date.parse(now) - Date.parse(owner.heartbeatAt) > leaseMs,
    waitingOn: waitingOn(options),
    ...result,
  };

  if (Object.keys(truncatedFields).length > 0) {
    view.truncatedFields = truncatedFields;
  }

  return view;
}

type SavedLoopyInput = Pick<LoopyView, "slug" | "workspace" | "scope" | "mode"> & {
  description?: string | null;
  input: Readonly<Exclude<LoopyView["input"], "schema">> | "schema";
  schedule?: { cron: string; tz?: string } | null;
};

function scheduleView(
  schedule: Schedule | null,
  declared: SavedLoopyInput["schedule"],
): LoopyView["schedule"] {
  if (schedule === null) {
    // LoopyView can show a schedule declared in the definition, not scheduled yet.
    return declared
      ? { cron: declared.cron, tz: declared.tz ?? "UTC", enabled: false, nextFireAt: null }
      : null;
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
    workspace: saved.workspace,
    description: saved.description ?? null,
    scope: saved.scope,
    mode: saved.mode,
    input: saved.input,
    schedule: scheduleView(schedule, saved.schedule),
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

export function graphView(graph: CoreGraph): GraphView {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.kind === "code") {
        return { ...node, module: { name: node.module.path.split("/").at(-1) ?? "" } };
      }

      return node.kind === "command"
        ? { ...node, parse: node.parse === null ? null : { input: node.parse.input } }
        : node;
    }),
    warnings: graph.warnings.map(({ code, message, node }) => ({
      code,
      message,
      nodeId: node,
      label: graph.nodes.find((entry) => entry.id === node)?.label ?? null,
    })),
  };
}
