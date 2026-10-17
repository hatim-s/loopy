import type { QueryClient } from "@tanstack/react-query";
import type {
  HookRecord,
  LogRecord,
  RunSnapshotView,
  RunView,
  ServerEvent,
  StepRecord,
} from "loopy/contract";
import type { LoopyBackend, StreamState } from "../backend/backend.ts";
import { keys } from "./keys.ts";
import { runQuery } from "./queries.ts";

type HookEvent = Extract<ServerEvent, { entity: "hook" }>;

function upsertBy<T>(items: T[], item: T, same: (a: T) => boolean, order: (a: T) => number): T[] {
  return [...items.filter((existing) => !same(existing)), item].sort((a, b) => order(a) - order(b));
}

function withStep(steps: StepRecord[], step: StepRecord): StepRecord[] {
  return upsertBy(
    steps,
    step,
    (existing) => existing.seq === step.seq,
    (item) => item.seq,
  );
}

function withLog(logs: LogRecord[], log: LogRecord): LogRecord[] {
  return upsertBy(
    logs,
    log,
    (existing) => existing.seq === log.seq,
    (item) => item.seq,
  );
}

function withHook(hooks: HookRecord[], hook: HookRecord): HookRecord[] {
  return upsertBy(
    hooks,
    hook,
    (existing) => existing.token === hook.token,
    (item) => item.seq,
  );
}

/** A created hook becomes what the run waits on; a resolved or expired one stops being it. */
function waitingAfter(run: RunView, event: HookEvent, steps: StepRecord[]): RunView["waitingOn"] {
  const hook = event.record;

  if (event.kind !== "created") {
    return run.waitingOn?.token === hook.token ? null : run.waitingOn;
  }

  const step = steps.find((item) => item.seq === hook.seq);
  const expiresAt = step?.status === "waiting" ? (step.wakeAt ?? null) : null;

  return { hook: hook.name, token: hook.token, seq: hook.seq, expiresAt };
}

function newer(current: RunView, next: RunView): boolean {
  return next.updatedAt >= current.updatedAt;
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

  switch (event.entity) {
    case "run": {
      return { ...next, run: event.record };
    }

    case "step": {
      return { ...next, steps: withStep(snapshot.steps, event.record) };
    }

    case "log": {
      return { ...next, logs: withLog(snapshot.logs, event.record) };
    }

    case "hook": {
      return {
        ...next,
        hooks: withHook(snapshot.hooks, event.record),
        run: { ...snapshot.run, waitingOn: waitingAfter(snapshot.run, event, snapshot.steps) },
      };
    }

    case "schedule": {
      return next;
    }
  }
}

/** Run lists carry no cursor, so they take a run only when it is at least as new. */
function applyToList(runs: RunView[], event: ServerEvent): RunView[] {
  if (event.entity === "run") {
    const record = event.record;

    return runs.map((run) => (run.id === record.id && newer(run, record) ? record : run));
  }

  if (event.entity === "hook") {
    return runs.map((run) =>
      run.id === event.record.runId ? { ...run, waitingOn: waitingAfter(run, event, []) } : run,
    );
  }

  return runs;
}

/** Writes one stream batch into every cached query it touches. */
export function applyBatch(client: QueryClient, batch: ServerEvent[]): void {
  const runIds = new Set(batch.flatMap((event) => (event.runId === null ? [] : [event.runId])));

  for (const id of runIds) {
    client.setQueryData<RunSnapshotView>(
      keys.run(id),
      (snapshot) => snapshot && batch.reduce(applyToSnapshot, snapshot),
    );
  }

  client.setQueriesData<RunView[]>(
    { queryKey: keys.runLists },
    (runs) => runs && batch.reduce(applyToList, runs),
  );

  const created = batch.some((event) => event.entity === "run" && event.kind === "created");

  const loopiesChanged = batch.some(
    (event) =>
      event.entity === "schedule" ||
      (event.entity === "run" && (event.kind === "created" || event.kind === "finished")),
  );

  if (created) {
    void client.invalidateQueries({ queryKey: keys.runLists });
  }

  if (loopiesChanged) {
    void client.invalidateQueries({ queryKey: keys.loopies });
  }
}

/** Writes a run returned by a mutation; the stream later confirms or supersedes it. */
export function applyRunView(client: QueryClient, run: RunView): void {
  client.setQueryData<RunSnapshotView>(
    keys.run(run.id),
    (snapshot) => snapshot && (newer(snapshot.run, run) ? { ...snapshot, run } : snapshot),
  );

  client.setQueriesData<RunView[]>({ queryKey: keys.runLists }, (runs) =>
    runs?.map((item) => (item.id === run.id && newer(item, run) ? run : item)),
  );
}

type FollowOptions = {
  client: QueryClient;
  backend: LoopyBackend;
  runId: string;
  signal: AbortSignal;
  onState: (state: StreamState) => void;
};

/**
 * Streams events from the run snapshot's cursor. When the backend no longer knows that
 * cursor or epoch, every cached query is invalidated and the stream restarts from the
 * refetched snapshot.
 */
export async function followRun({ client, backend, runId, signal, onState }: FollowOptions) {
  while (!signal.aborted) {
    const snapshot = await client.fetchQuery(runQuery(backend, runId));

    const end = await backend.events({
      after: snapshot.cursor,
      epoch: snapshot.epoch,
      signal,
      onState,
      onBatch: (batch) => applyBatch(client, batch),
    });

    if (end === "aborted") {
      return;
    }

    onState("reconnecting");
    await client.invalidateQueries();
  }
}
