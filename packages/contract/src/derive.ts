import {
  type Graph,
  type Json,
  MAX_PREVIEW_BYTES,
  outputBytes,
  type RunRecord,
  type RuntimeEvent,
  type Schedule,
} from "@loopy/core";
import type { PendingHook, RunPreview, StatusCounts } from "./dashboard-reader";
import type { GraphView } from "./graph";
import type { LoopyView, RunView, ScheduleView, ServerEvent } from "./views";

type RunViewOptions = {
  run: RunPreview;
  hook: PendingHook | undefined;
  // The store decides staleness because only it knows whether a local owner is still alive.
  ownerStale: boolean;
};

function outcome(run: RunRecord) {
  switch (run.status) {
    case "succeeded":
      return { status: run.status, output: run.output };
    case "failed":
      return { status: run.status, error: run.error };
    case "suspended":
      return { status: run.status, wakeAt: run.wakeAt };
    default:
      return { status: run.status };
  }
}

/** Views inline a payload up to the preview cap and report only its size beyond it. */
export function previewPayload(value: Json): { value: Json; bytes: number | null } {
  const bytes = outputBytes(value);

  return bytes > MAX_PREVIEW_BYTES ? { value: null, bytes } : { value, bytes: null };
}

export function runView(options: RunViewOptions): RunView {
  const { run } = options;

  const owner = run.owner
    ? { pid: run.owner.pid, host: run.owner.host, heartbeatAt: run.owner.heartbeatAt }
    : null;

  const input = previewPayload(run.input);
  const result = outcome(run);
  const output = result.status === "succeeded" ? previewPayload(result.output) : null;

  const truncatedFields: NonNullable<RunView["truncatedFields"]> = { ...run.truncatedFields };

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
    input: input.value,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    owner,
    ownerStale: owner !== null && options.ownerStale,
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

function loopySchedule(
  schedule: Schedule | null,
  declared: SavedLoopyInput["schedule"],
): LoopyView["schedule"] {
  if (schedule === null) {
    return declared && { state: "declared", cron: declared.cron, tz: declared.tz };
  }

  return {
    state: "saved",
    cron: schedule.cron,
    tz: schedule.tz,
    enabled: schedule.enabled,
    nextFireAt: schedule.nextFireAt,
  };
}

/** Counts and the newest runs come from the store, scoped like the definition. */
export function loopyView(
  saved: SavedLoopyInput,
  schedule: Schedule | null,
  runs: { counts: StatusCounts; latest: RunView[] },
): LoopyView {
  return {
    slug: saved.slug,
    workspace: saved.workspace,
    description: saved.description,
    scope: saved.scope,
    mode: saved.mode,
    input: saved.input,
    schedule: loopySchedule(schedule, saved.schedule),
    lastRun: runs.latest[0] ?? null,
    latestRuns: runs.latest,
    counts: runs.counts,
  };
}

type NodeEvent = Extract<RuntimeEvent, { entity: "node" }>;

type NodeEventView = Extract<ServerEvent, { entity: "node" }>;

/** Event history serves node records whole; the input view stays with execution detail. */
export function nodeDetailEvent(event: NodeEvent): NodeEventView {
  const record = { ...event.record };
  delete record.inputView;

  return { ...event, record };
}

/** Live frames carry an output only within the preview cap. */
function nodeEventPreview(event: NodeEvent): NodeEventView {
  const view = nodeDetailEvent(event);

  if (view.record.status !== "succeeded") {
    return view;
  }

  const output = previewPayload(view.record.output);

  return output.bytes === null
    ? view
    : { ...view, truncatedOutputBytes: output.bytes, record: { ...view.record, output: null } };
}

/** The wire view of a schedule, where a schedule that never fired has a null fire key. */
export function scheduleView(schedule: Schedule, failure: ScheduleView["failure"]): ScheduleView {
  return { ...schedule, lastFireKey: schedule.lastFireKey ?? null, failure };
}

/** The live-stream view of one runtime event. */
export function serverEvent(event: RuntimeEvent, view: (run: RunRecord) => RunView): ServerEvent {
  switch (event.entity) {
    case "run": {
      return { ...event, record: view(event.record) };
    }

    case "node": {
      return nodeEventPreview(event);
    }

    case "schedule": {
      return event.kind === "deleted"
        ? event
        : { ...event, record: scheduleView(event.record, event.record.failure) };
    }

    default: {
      return event;
    }
  }
}

export function graphView(graph: Graph): GraphView {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      if (node.kind === "code") {
        return { ...node, module: { name: node.module.path.split("/").at(-1) ?? "" } };
      }

      return node.kind === "command" ? { ...node, parse: node.parse !== null } : node;
    }),
  };
}
