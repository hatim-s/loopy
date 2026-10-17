import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type {
  HookRecord,
  LogRecord,
  RunSnapshotView,
  RunView,
  ServerEvent,
  StepRecord,
} from "loopy/contract";
import type { LoopyBackend, RunsQuery, StreamState } from "../backend/backend.ts";
import { keys } from "./keys.ts";

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

  return { hook: hook.name, token: hook.token, seq: hook.seq, since: hook.createdAt, expiresAt };
}

function newer(current: RunView, next: RunView): boolean {
  return next.updatedAt >= current.updatedAt;
}

function withSnapshotHook(snapshot: RunSnapshotView, event: HookEvent): RunSnapshotView {
  const run = snapshot.run;

  return {
    ...snapshot,
    hooks: withHook(snapshot.hooks, event.record),
    run:
      event.at >= run.updatedAt
        ? { ...run, waitingOn: waitingAfter(run, event, snapshot.steps) }
        : run,
  };
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
      return withSnapshotHook(next, event);
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

function applyHookToList(
  runs: RunView[],
  event: HookEvent,
  snapshot: RunSnapshotView | undefined,
): RunView[] {
  return runs.map((run) =>
    run.id === event.record.runId && event.at >= run.updatedAt && canApplyHook(event, snapshot)
      ? { ...run, waitingOn: waitingAfter(run, event, snapshot?.steps ?? []) }
      : run,
  );
}

type BatchChanges = { lists: Set<string>; loopies: boolean };

type StreamHistory = { sequences: Map<string, number>; runs: Map<string, RunView> };

type BatchContext = { client: QueryClient; history: StreamHistory; changes: BatchChanges };

// Lists have no wire cursor, so replay protection belongs to the session reducer.
const histories = new WeakMap<QueryClient, StreamHistory>();

function matchesRun(filters: RunsQuery, run: RunView): boolean {
  return (
    (filters.slug === undefined || filters.slug === run.slug) &&
    (filters.status === undefined || filters.status === run.status) &&
    (filters.waiting === undefined || filters.waiting === (run.waitingOn !== null))
  );
}

function replaceMember(runs: RunView[], next: RunView, filters: RunsQuery): RunView[] {
  return runs.flatMap((run) => {
    if (run.id !== next.id || !newer(run, next)) {
      return [run];
    }

    return matchesRun(filters, next) ? [next] : [];
  });
}

function updateMembership(client: QueryClient, run: RunView, previous?: RunView): Set<string> {
  const missing = new Set<string>();

  for (const query of client.getQueryCache().findAll({ queryKey: keys.runLists })) {
    const key = query.queryKey;

    if (key[0] !== "runs" || key[1] === undefined) {
      continue;
    }

    const filters = key[1] === "pages" ? key[2] : key[1];
    const list = client.getQueryData<RunList>(key);
    const present = runListHas(list, run.id);

    if (present) {
      client.setQueryData<RunList>(key, (current) =>
        mapRunList(current, (runs) => replaceMember(runs, run, filters)),
      );
    } else if (
      matchesRun(filters, run) ||
      (previous !== undefined && matchesRun(filters, previous))
    ) {
      missing.add(query.queryHash);
    }
  }

  return missing;
}

function cachedRun(client: QueryClient, id: string): RunView | undefined {
  const snapshot = client.getQueryData<RunSnapshotView>(keys.run(id));

  if (snapshot) {
    return snapshot.run;
  }

  for (const [, list] of client.getQueriesData<RunList>({ queryKey: keys.runLists })) {
    const pages = list === undefined || Array.isArray(list) ? [list ?? []] : list.pages;
    const run = pages.flat().find((item) => item.id === id);

    if (run) {
      return run;
    }
  }

  return undefined;
}

function applyHookLists(
  { client, changes }: BatchContext,
  event: HookEvent,
  snapshot: RunSnapshotView | undefined,
): void {
  for (const query of client.getQueryCache().findAll({ queryKey: keys.runLists })) {
    const list = client.getQueryData<RunList>(query.queryKey);

    if (!canApplyHook(event, snapshot) && runListHas(list, event.record.runId)) {
      changes.lists.add(query.queryHash);
    }

    client.setQueryData<RunList>(query.queryKey, (current) =>
      mapRunList(current, (runs) => applyHookToList(runs, event, snapshot)),
    );
  }
}

function applyRunEvent(
  { client, history, changes }: BatchContext,
  event: Extract<ServerEvent, { entity: "run" }>,
): void {
  const previous = history.runs.get(event.record.id) ?? cachedRun(client, event.record.id);

  if (previous !== undefined && !newer(previous, event.record)) {
    return;
  }

  const status = history.runs.get(event.record.id)?.status;

  const missing = updateMembership(client, event.record, previous);

  if (event.kind !== "heartbeat") {
    for (const hash of missing) {
      changes.lists.add(hash);
    }
  }

  changes.loopies ||=
    status === undefined ? event.kind !== "heartbeat" : status !== event.record.status;
  history.runs.set(event.record.id, event.record);
}

function acceptEvent(history: StreamHistory, event: ServerEvent): boolean {
  const identity =
    event.entity === "schedule"
      ? `schedule:${event.record.workspace}:${event.record.slug}`
      : event.runId;

  if (identity === null) {
    return false;
  }

  if (event.sequence <= (history.sequences.get(identity) ?? -1)) {
    return false;
  }

  history.sequences.set(identity, event.sequence);

  return true;
}

function applyEvent(context: BatchContext, event: ServerEvent): void {
  const { client, history, changes } = context;

  const snapshot =
    event.runId === null ? undefined : client.getQueryData<RunSnapshotView>(keys.run(event.runId));

  if (!acceptEvent(history, event)) {
    return;
  }

  if (event.entity === "schedule") {
    changes.loopies = true;

    return;
  }

  if (event.entity === "run") {
    applyRunEvent(context, event);
  } else if (event.entity === "hook") {
    applyHookLists(context, event, snapshot);
  }

  if (event.runId !== null) {
    client.setQueryData<RunSnapshotView>(
      keys.run(event.runId),
      (current) => current && applyToSnapshot(current, event),
    );
  }
}

/** Writes a transaction before refetching each affected list once. */
export function applyBatch(client: QueryClient, batch: ServerEvent[]): void {
  const history = histories.get(client) ?? { sequences: new Map(), runs: new Map() };
  histories.set(client, history);
  const changes: BatchChanges = { lists: new Set(), loopies: false };

  for (const event of batch) {
    applyEvent({ client, history, changes }, event);
  }

  if (changes.lists.size > 0) {
    void client.invalidateQueries({
      queryKey: keys.runLists,
      predicate: (query) => changes.lists.has(query.queryHash),
    });
  }

  if (changes.loopies) {
    void client.invalidateQueries({ queryKey: keys.loopies });
  }
}

/** Writes a run returned by a mutation; the stream later confirms or supersedes it. */
export function applyRunView(client: QueryClient, run: RunView): void {
  client.setQueryData<RunSnapshotView>(
    keys.run(run.id),
    (snapshot) => snapshot && (newer(snapshot.run, run) ? { ...snapshot, run } : snapshot),
  );

  const missing = updateMembership(client, run);
  void client.invalidateQueries({
    queryKey: keys.runLists,
    predicate: (query) => missing.has(query.queryHash),
  });
  void client.invalidateQueries({ queryKey: keys.loopies });
}

type FollowOptions = {
  client: QueryClient;
  backend: LoopyBackend;
  signal: AbortSignal;
  onState: (state: StreamState) => void;
};

/** A cursor precedes the initial refetch so writes during that refetch are replayed. */
async function followCursors({ client, backend, signal, onState }: FollowOptions) {
  while (!signal.aborted) {
    const cursor = await backend.cursor(signal);
    await client.invalidateQueries();

    if (signal.aborted) {
      return;
    }

    const end = await backend.events({
      after: cursor.cursor,
      epoch: cursor.epoch,
      signal,
      onState,
      onBatch: (batch) => applyBatch(client, batch),
    });

    if (end === "aborted" || signal.aborted) {
      return;
    }

    histories.delete(client);
    onState("reconnecting");
  }
}

/** Transport reconnects keep their cursor; a reset starts a new cache session. */
export async function followSession(options: FollowOptions): Promise<void> {
  try {
    await followCursors(options);
  } catch (error) {
    if (!options.signal.aborted) {
      throw error;
    }
  }
}
