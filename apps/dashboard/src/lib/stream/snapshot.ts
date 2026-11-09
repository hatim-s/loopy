import {
  executionKeyString,
  type NodeRun,
  PAGE_LIMIT,
  type RunSnapshotView,
  type RunView,
  type ServerEvent,
} from "@loopy/contract";

export type HookEvent = Extract<ServerEvent, { entity: "hook" }>;

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
        .slice(0, PAGE_LIMIT);
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
    ).slice(-PAGE_LIMIT),
    hooksTruncated: snapshot.hooksTruncated || snapshot.hooks.length >= PAGE_LIMIT,
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

  // Live frames already carry the server's output preview and its byte count.
  const record = event.record;
  const nodeRuns = withNodeRun(snapshot.nodeRuns, record);

  const inserted = !snapshot.nodeRuns.some(
    (node) => executionKeyString(node.key) === executionKeyString(record.key),
  );

  const last = nodeRuns.at(-1);
  let nodeRunsNext = snapshot.nodeRunsNext;

  if (inserted && snapshot.nodeRuns.length >= PAGE_LIMIT && last) {
    nodeRunsNext = executionKeyString(last.key);
  }

  const retained = new Map(
    nodeRuns.map((node) => [
      executionKeyString(node.key),
      snapshot.truncatedOutputs[executionKeyString(node.key)],
    ]),
  );

  retained.set(executionKeyString(record.key), event.truncatedOutputBytes);

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
    next.run = newer(snapshot.run, event.record) ? event.record : snapshot.run;
  } else if (event.entity === "node") {
    return withSnapshotNode(next, event);
  } else if (event.entity === "hook") {
    return withSnapshotHook(next, event);
  }

  return next;
}
