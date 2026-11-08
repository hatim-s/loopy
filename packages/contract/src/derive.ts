import {
  emptyRunCounts,
  type Graph,
  type Json,
  MAX_PREVIEW_BYTES,
  outputBytes,
  type PendingHook,
  type RunRecord,
  type RuntimeEvent,
  type Schedule,
} from "@loopy/core";
import type { GraphView } from "./graph";
import type { LoopyView, RunView, ServerEvent } from "./views";

type RunViewOptions = {
  run: RunRecord;
  loopy: RunView["loopy"];
  hook: PendingHook | undefined;
  now: string;
  leaseMs: number;
};

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

    case "suspended":
      return { status: run.status, wakeAt: run.wakeAt ?? null };
    default:
      return { status: run.status };
  }
}

function previewPayload(value: Json): { value: Json; bytes: number | null } {
  const bytes = outputBytes(value);

  return bytes > MAX_PREVIEW_BYTES ? { value: null, bytes } : { value, bytes: null };
}

export function runView(options: RunViewOptions): RunView {
  const { run, now, leaseMs } = options;

  const owner = run.owner
    ? { pid: run.owner.pid, host: run.owner.host, heartbeatAt: run.owner.heartbeatAt }
    : null;

  const input = previewPayload(run.input);
  const result = outcome(run);
  const output = result.status === "succeeded" ? previewPayload(result.output) : null;

  const truncatedFields: NonNullable<RunRecord["truncatedFields"]> = { ...run.truncatedFields };

  if (input.bytes !== null) {
    truncatedFields.input = input.bytes;
  }

  if (output !== null && output.bytes !== null) {
    truncatedFields.output = output.bytes;
  }

  if (result.status === "succeeded" && output !== null) {
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
    waitingOn: options.hook
      ? {
          hook: options.hook.name,
          token: options.hook.token,
          seq: options.hook.seq,
          expiresAt: options.hook.expiresAt,
          since: options.hook.createdAt,
        }
      : null,
    ...result,
  };

  if (Object.keys(truncatedFields).length > 0) {
    return { ...view, truncatedFields };
  }

  return view;
}

type SavedLoopyInput = Pick<LoopyView, "slug" | "workspace" | "scope" | "mode" | "input"> & {
  description: string | null;
  schedule: Graph["meta"]["schedule"];
};

function scheduleView(
  schedule: Schedule | null,
  declared: SavedLoopyInput["schedule"],
): LoopyView["schedule"] {
  if (schedule === null) {
    return declared ? { ...declared, enabled: false, nextFireAt: null } : null;
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

  const counts = emptyRunCounts();

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
    description: saved.description,
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

export function graphView(graph: Graph): GraphView {
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
