import type { InfiniteData, QueryClient } from "@tanstack/react-query";
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

/** A `["runs", ...]` cache entry: one page from `useQuery`, or the pages of `useInfiniteQuery`. */
type RunList = RunView[] | InfiniteData<RunView[], unknown>;

function mapRunList(list: RunList | undefined, update: (runs: RunView[]) => RunView[]) {
  if (list === undefined || Array.isArray(list)) {
    return list && update(list);
  }

  return { ...list, pages: list.pages.map(update) };
}

function runListHas(list: RunList | undefined, id: string): boolean {
  const pages = list === undefined || Array.isArray(list) ? [list ?? []] : list.pages;

  return pages.some((runs) => runs.some((run) => run.id === id));
}

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

  if (hook.resolvedAt !== undefined || hook.expiredAt !== undefined) {
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
        run:
          event.at >= snapshot.run.updatedAt
            ? { ...snapshot.run, waitingOn: waitingAfter(snapshot.run, event, snapshot.steps) }
            : snapshot.run,
      };
    }

    case "schedule": {
      return next;
    }
  }
}

function hookNeedsSteps(event: HookEvent): boolean {
  return event.record.resolvedAt === undefined && event.record.expiredAt === undefined;
}

function canApplyHook(event: HookEvent, snapshot: RunSnapshotView | undefined): boolean {
  return (
    !hookNeedsSteps(event) ||
    (snapshot?.steps.some(
      (step) => step.seq === event.record.seq && step.status === "waiting" && step.kind === "hook",
    ) ??
      false)
  );
}

/** Run lists carry no cursor, so they take a run only when it is at least as new. */
function applyToList(
  runs: RunView[],
  event: ServerEvent,
  snapshot: RunSnapshotView | undefined,
): RunView[] {
  if (event.entity === "run") {
    const record = event.record;

    return runs.map((run) => (run.id === record.id && newer(run, record) ? record : run));
  }

  if (event.entity === "hook") {
    return runs.map((run) =>
      run.id === event.record.runId &&
      event.at >= run.updatedAt &&
      (snapshot === undefined || event.sequence > snapshot.cursor) &&
      canApplyHook(event, snapshot)
        ? { ...run, waitingOn: waitingAfter(run, event, snapshot?.steps ?? []) }
        : run,
    );
  }

  return runs;
}

// Lists have no wire cursor, so retain the sequence of events already applied to them.
const listCursors = new WeakMap<QueryClient, Map<string, number>>();

function applyEvent(client: QueryClient, event: ServerEvent): void {
  if (event.runId === null) {
    return;
  }

  const cursors = listCursors.get(client) ?? new Map<string, number>();
  listCursors.set(client, cursors);
  const snapshot = client.getQueryData<RunSnapshotView>(keys.run(event.runId));

  if (event.sequence > (cursors.get(event.runId) ?? -1)) {
    client.setQueriesData<RunList>({ queryKey: keys.runLists }, (list) =>
      mapRunList(list, (runs) => applyToList(runs, event, snapshot)),
    );
    cursors.set(event.runId, event.sequence);

    if (event.entity === "hook" && !canApplyHook(event, snapshot)) {
      void client.invalidateQueries({
        queryKey: keys.runLists,
        predicate: (query) =>
          runListHas(client.getQueryData<RunList>(query.queryKey), event.record.runId),
      });
    }
  }

  client.setQueryData<RunSnapshotView>(
    keys.run(event.runId),
    (current) => current && applyToSnapshot(current, event),
  );
}

/** Writes one stream batch into every cached query it touches. */
export function applyBatch(client: QueryClient, batch: ServerEvent[]): void {
  for (const event of batch) {
    applyEvent(client, event);
  }

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

  client.setQueriesData<RunList>({ queryKey: keys.runLists }, (list) =>
    mapRunList(list, (runs) =>
      runs.map((item) => (item.id === run.id && newer(item, run) ? run : item)),
    ),
  );
}

type FollowOptions = {
  client: QueryClient;
  backend: LoopyBackend;
  runId: string;
  signal: AbortSignal;
  onState: (state: StreamState) => void;
};

async function followSnapshots({ client, backend, runId, signal, onState }: FollowOptions) {
  while (!signal.aborted) {
    const snapshot = await client.fetchQuery(runQuery(backend, runId));

    if (signal.aborted) {
      return;
    }

    const end = await backend.events({
      after: snapshot.cursor,
      epoch: snapshot.epoch,
      signal,
      onState,
      onBatch: (batch) => applyBatch(client, batch),
    });

    if (end === "aborted" || signal.aborted) {
      return;
    }

    listCursors.delete(client);
    onState("reconnecting");
    await client.invalidateQueries();
  }
}

/** Reset recovery refetches the snapshot before choosing the next stream cursor. */
export async function followRun(options: FollowOptions) {
  const { client, runId, signal } = options;

  const cancel = () => {
    void client.cancelQueries({ queryKey: keys.run(runId), exact: true });
  };

  signal.addEventListener("abort", cancel, { once: true });

  try {
    await followSnapshots(options);
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await client.cancelQueries({ queryKey: keys.run(runId), exact: true });
  }
}
