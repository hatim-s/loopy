import {
  executionKeyString,
  type Json,
  type NodeRun,
  type RunSnapshotView,
  type RunView,
  type ServerEvent,
} from "@loopy/contract";

export const SNAPSHOT_RECORD_LIMIT = 200;

const SNAPSHOT_VALUE_BYTES = 16_384;

export type HookEvent = Extract<ServerEvent, { entity: "hook" }>;

function jsonBytes(value: Json): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export function previewRun(run: RunView): RunView {
  const inputBytes = jsonBytes(run.input);
  const outputBytes = run.status === "succeeded" ? jsonBytes(run.output) : 0;

  if (inputBytes <= SNAPSHOT_VALUE_BYTES && outputBytes <= SNAPSHOT_VALUE_BYTES) {
    return run;
  }

  const next = { ...run, truncatedFields: { ...run.truncatedFields } };

  if (inputBytes > SNAPSHOT_VALUE_BYTES) {
    next.input = null;
    next.truncatedFields.input = inputBytes;
  }

  if (outputBytes > SNAPSHOT_VALUE_BYTES && next.status === "succeeded") {
    next.output = null;
    next.truncatedFields.output = outputBytes;
  }

  return next;
}

export function newer(current: RunView, next: RunView): boolean {
  return next.updatedAt >= current.updatedAt;
}

function upsertBy<T>(items: T[], item: T, same: (a: T) => boolean, order: (a: T) => number): T[] {
  return [...items.filter((existing) => !same(existing)), item].sort((a, b) => order(a) - order(b));
}

/** A hook event carries wait identity; the run view carries its native expiry. */
export function waitingAfter(run: RunView, event: HookEvent): RunView["waitingOn"] {
  const hook = event.record;

  if (hook.resolvedAt !== undefined || hook.expiredAt !== undefined) {
    return run.waitingOn?.token === hook.token ? null : run.waitingOn;
  }

  const expiresAt = run.waitingOn?.token === hook.token ? run.waitingOn.expiresAt : null;

  return { hook: hook.name, token: hook.token, seq: hook.seq, since: hook.createdAt, expiresAt };
}

function withNodeRun(runs: NodeRun[], record: NodeRun): NodeRun[] {
  const key = executionKeyString(record.key);

  return runs.some((run) => executionKeyString(run.key) === key)
    ? runs.map((run) => (executionKeyString(run.key) === key ? record : run))
    : [...runs, record]
        .sort((a, b) => (executionKeyString(a.key) < executionKeyString(b.key) ? -1 : 1))
        .slice(0, SNAPSHOT_RECORD_LIMIT);
}

function withSnapshotHook(snapshot: RunSnapshotView, event: HookEvent): RunSnapshotView {
  const run = snapshot.run;

  return {
    ...snapshot,
    hooks: upsertBy(
      snapshot.hooks,
      event.record,
      (hook) => hook.token === event.record.token,
      (hook) => hook.seq,
    ).slice(-SNAPSHOT_RECORD_LIMIT),
    hooksTruncated: snapshot.hooksTruncated || snapshot.hooks.length >= SNAPSHOT_RECORD_LIMIT,
    run: event.at >= run.updatedAt ? { ...run, waitingOn: waitingAfter(run, event) } : run,
  };
}

function withSnapshotNode(
  snapshot: RunSnapshotView,
  event: Extract<ServerEvent, { entity: "node" }>,
): RunSnapshotView {
  if (event.record.key.scope.length > 0) {
    return snapshot;
  }

  const record = { ...event.record };
  delete record.inputView;

  const bytes =
    record.status === "succeeded" ? (event.truncatedOutputBytes ?? jsonBytes(record.output)) : 0;

  if (bytes > SNAPSHOT_VALUE_BYTES && record.status === "succeeded") {
    record.output = null;
  }

  const nodeRuns = withNodeRun(snapshot.nodeRuns, record);

  const inserted = !snapshot.nodeRuns.some(
    (node) => executionKeyString(node.key) === executionKeyString(record.key),
  );

  const last = nodeRuns.at(-1);
  let nodeRunsNext = snapshot.nodeRunsNext;

  if (inserted && snapshot.nodeRuns.length >= SNAPSHOT_RECORD_LIMIT && last) {
    nodeRunsNext = executionKeyString(last.key);
  }

  const retained = new Map(
    nodeRuns.map((node) => [
      executionKeyString(node.key),
      snapshot.truncatedOutputs?.[executionKeyString(node.key)],
    ]),
  );

  retained.set(executionKeyString(record.key), bytes > SNAPSHOT_VALUE_BYTES ? bytes : undefined);

  const truncatedOutputs = Object.fromEntries(
    [...retained].flatMap(([key, size]) => (size === undefined ? [] : [[key, size]])),
  );

  return { ...snapshot, nodeRuns, nodeRunsNext, truncatedOutputs };
}

/**
 * Applies one event to a run snapshot. Events at or below the snapshot cursor are already
 * part of it, so a replayed batch changes nothing.
 */
export function applyToSnapshot(snapshot: RunSnapshotView, event: ServerEvent): RunSnapshotView {
  if (event.sequence <= snapshot.cursor || event.runId !== snapshot.run.id) {
    return snapshot;
  }

  const next = { ...snapshot, cursor: event.sequence };

  if (event.entity === "run") {
    next.run = newer(snapshot.run, event.record) ? previewRun(event.record) : snapshot.run;
  } else if (event.entity === "node") {
    return withSnapshotNode(next, event);
  } else if (event.entity === "log") {
    const log = { ...event.record };
    delete log.data;
    next.logs = upsertBy(
      snapshot.logs,
      log,
      (log) => log.seq === event.record.seq,
      (log) => log.seq,
    ).slice(-SNAPSHOT_RECORD_LIMIT);
  } else if (event.entity === "hook") {
    return withSnapshotHook(next, event);
  }

  return next;
}
