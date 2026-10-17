import type { InfiniteData, Query, QueryClient } from "@tanstack/react-query";
import type {
  HookRecord,
  LogRecord,
  RunSnapshotView,
  RunView,
  ScheduleView,
  ServerEvent,
  StepRecord,
} from "loopy/contract";
import type { LoopyBackend, RunsQuery, StreamState } from "../backend/backend.ts";
import { keys } from "./keys.ts";
import type { RunPage } from "./queries.ts";

type HookEvent = Extract<ServerEvent, { entity: "hook" }>;

type ScheduleEvent = Extract<ServerEvent, { entity: "schedule" }>;

type ScheduleId = Pick<ScheduleView, "workspace" | "slug">;

/** A `["runs", ...]` cache entry: one page from `useQuery`, or the pages of `useInfiniteQuery`. */
type RunList = RunView[] | InfiniteData<RunPage, unknown>;

function mapRunList(list: RunList | undefined, update: (runs: RunView[]) => RunView[]) {
  if (list === undefined || Array.isArray(list)) {
    return list && update(list);
  }

  return { ...list, pages: list.pages.map((page) => ({ ...page, runs: update(page.runs) })) };
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
      return { ...next, run: newer(snapshot.run, event.record) ? event.record : snapshot.run };
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

type BatchChanges = { lists: Set<string>; loopies: boolean; schedules: boolean };

type RunEvent = Extract<ServerEvent, { entity: "run" }>;

type StreamHistory = {
  sequences: Map<string, number>;
  runs: Map<string, { sequence: number; run: RunView }>;
  lists: WeakMap<Query, Map<string, { sequence: number; run: RunView }>>;
};

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

function listRun(list: RunList | undefined, id: string): RunView | undefined {
  const pages =
    list === undefined || Array.isArray(list) ? [list ?? []] : list.pages.map((page) => page.runs);

  return pages.flat().find((run) => run.id === id);
}

function acceptListRun(
  previous: RunView | undefined,
  query: Query,
  write: { history: StreamHistory; event: RunEvent },
): boolean {
  const { history, event } = write;
  const runs = history.lists.get(query) ?? new Map<string, { sequence: number; run: RunView }>();
  const saved = runs.get(event.record.id);
  const current = previous ?? saved?.run;

  if (
    event.sequence <= (saved?.sequence ?? -1) ||
    (current !== undefined && !newer(current, event.record))
  ) {
    return false;
  }

  runs.set(event.record.id, { sequence: event.sequence, run: event.record });
  // Query identity lets garbage collection discard list freshness with the cached data.
  history.lists.set(query, runs);

  return true;
}

function updateMembership(
  client: QueryClient,
  run: RunView,
  write?: { history: StreamHistory; event: RunEvent },
): Set<string> {
  const missing = new Set<string>();

  for (const query of client.getQueryCache().findAll({ queryKey: keys.runLists })) {
    const key = query.queryKey;

    if (key[0] !== "runs" || key[1] === undefined) {
      continue;
    }

    const filters = key[1] === "pages" ? key[2] : key[1];
    const list = client.getQueryData<RunList>(key);
    const previous = listRun(list, run.id);

    if (write !== undefined && !acceptListRun(previous, query, write)) {
      continue;
    }

    if (previous !== undefined) {
      client.setQueryData<RunList>(key, (current) =>
        mapRunList(current, (runs) => replaceMember(runs, run, filters)),
      );
    } else if (matchesRun(filters, run)) {
      missing.add(query.queryHash);
    }
  }

  return missing;
}

function applyHookLists(
  { client, changes }: BatchContext,
  event: HookEvent,
  snapshot: RunSnapshotView | undefined,
): void {
  for (const query of client.getQueryCache().findAll({ queryKey: keys.runLists })) {
    const list = client.getQueryData<RunList>(query.queryKey);

    if (!canApplyHook(event, snapshot) && listRun(list, event.record.runId) !== undefined) {
      changes.lists.add(query.queryHash);
    }

    client.setQueryData<RunList>(query.queryKey, (current) =>
      mapRunList(current, (runs) => applyHookToList(runs, event, snapshot)),
    );
  }
}

function applyRunEvent({ client, history, changes }: BatchContext, event: RunEvent): void {
  const missing = updateMembership(client, event.record, { history, event });

  if (event.kind === "heartbeat") {
    return;
  }

  for (const hash of missing) {
    changes.lists.add(hash);
  }

  const previous = history.runs.get(event.record.id);

  if (
    previous !== undefined &&
    (event.sequence <= previous.sequence || !newer(previous.run, event.record))
  ) {
    return;
  }

  changes.loopies ||= previous === undefined || previous.run.status !== event.record.status;
  history.runs.set(event.record.id, { sequence: event.sequence, run: event.record });
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

  if (event.entity === "run") {
    applyRunEvent(context, event);
    acceptEvent(history, event);
  } else if (!acceptEvent(history, event)) {
    return;
  }

  if (event.entity === "schedule") {
    changes.loopies = true;
    changes.schedules ||= !applyScheduleEvent(client, event);

    return;
  }

  if (event.entity === "hook") {
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
  const history = histories.get(client) ?? {
    sequences: new Map(),
    runs: new Map(),
    lists: new WeakMap(),
  };

  histories.set(client, history);
  const changes: BatchChanges = { lists: new Set(), loopies: false, schedules: false };

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

  if (changes.schedules) {
    void client.invalidateQueries({ queryKey: keys.schedules });
  }
}

function sameSchedule(a: ScheduleId, b: ScheduleId): boolean {
  return a.workspace === b.workspace && a.slug === b.slug;
}

/** A lower revision is older than what the list holds; a fire keeps the revision it fired. */
function withSchedule(list: ScheduleView[], next: ScheduleView): ScheduleView[] {
  const current = list.find((item) => sameSchedule(item, next));

  if (current && current.revision > next.revision) {
    return list;
  }

  return current
    ? list.map((item) => (item === current ? next : item))
    : [...list, next].sort((a, b) => a.slug.localeCompare(b.slug));
}

/**
 * Writes a schedule event into the list and reports whether the list now holds the truth.
 * GET /schedules covers one workspace and an event does not say whether it is that one, so
 * a schedule the list has not seen yet is left for a refetch instead of inserted.
 */
function applyScheduleEvent(client: QueryClient, event: ScheduleEvent): boolean {
  const list = client.getQueryData<ScheduleView[]>(keys.schedules);

  if (list === undefined) {
    return true;
  }

  if (event.kind === "deleted") {
    client.setQueryData<ScheduleView[]>(keys.schedules, (current) =>
      current?.filter((item) => !sameSchedule(item, event.record)),
    );

    return true;
  }

  if (!list.some((item) => sameSchedule(item, event.record))) {
    return false;
  }

  const view = { ...event.record, lastFireKey: event.record.lastFireKey ?? null };
  client.setQueryData<ScheduleView[]>(
    keys.schedules,
    (current) => current && withSchedule(current, view),
  );

  return true;
}

/** Writes a schedule returned by a mutation. It belongs to the listed workspace, so it may insert. */
export function applyScheduleView(client: QueryClient, view: ScheduleView): void {
  client.setQueryData<ScheduleView[]>(
    keys.schedules,
    (current) => current && withSchedule(current, view),
  );
  void client.invalidateQueries({ queryKey: keys.loopies });
}

export function removeScheduleView(client: QueryClient, slug: string): void {
  client.setQueryData<ScheduleView[]>(keys.schedules, (current) =>
    current?.filter((item) => item.slug !== slug),
  );
  void client.invalidateQueries({ queryKey: keys.loopies });
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
