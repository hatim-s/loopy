import type { InfiniteData, Query, QueryClient } from "@tanstack/react-query";
import {
  executionKeyString,
  type Json,
  type NodeRunView,
  type RunSnapshotView,
  type RunView,
  type ScheduleView,
  type ServerEvent,
} from "loopy/contract";
import type { LoopyBackend, RunsQuery, StreamState } from "../backend/backend.ts";
import { keys } from "./keys.ts";
import type { RunPage } from "./queries.ts";

export const SNAPSHOT_RECORD_LIMIT = 200;

export const STREAM_HISTORY_LIMIT = 2048;

const REFRESH_DELAY_MS = 250;

const SNAPSHOT_VALUE_BYTES = 16_384;

function jsonBytes(value: Json): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function previewRun(run: RunView): RunView {
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

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);

  if (map.size > STREAM_HISTORY_LIMIT) {
    const oldest = map.keys().next();

    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
}

type HookEvent = Extract<ServerEvent, { entity: "hook" }>;

type ScheduleEvent = Extract<ServerEvent, { entity: "schedule" }>;

type ScheduleId = Pick<ScheduleView, "workspace" | "slug">;

/** A `["runs", ...]` cache entry: one page from `useQuery`, or the pages of `useInfiniteQuery`. */
type RunList = RunView[] | RunPage | InfiniteData<RunPage, unknown>;

function mapRunList(list: RunList | undefined, update: (runs: RunView[]) => RunView[]) {
  if (list === undefined || Array.isArray(list)) {
    return list && update(list);
  }

  if ("runs" in list) {
    return { ...list, runs: update(list.runs) };
  }

  return { ...list, pages: list.pages.map((page) => ({ ...page, runs: update(page.runs) })) };
}

function upsertBy<T>(items: T[], item: T, same: (a: T) => boolean, order: (a: T) => number): T[] {
  return [...items.filter((existing) => !same(existing)), item].sort((a, b) => order(a) - order(b));
}

/** A hook event carries wait identity; the run view carries its native expiry. */
function waitingAfter(run: RunView, event: HookEvent): RunView["waitingOn"] {
  const hook = event.record;

  if (hook.resolvedAt !== undefined || hook.expiredAt !== undefined) {
    return run.waitingOn?.token === hook.token ? null : run.waitingOn;
  }

  const expiresAt = run.waitingOn?.token === hook.token ? run.waitingOn.expiresAt : null;

  return { hook: hook.name, token: hook.token, seq: hook.seq, since: hook.createdAt, expiresAt };
}

/** One record per execution key: a later attempt replaces the earlier one in place. */
function withNodeRun(runs: NodeRunView[], record: NodeRunView): NodeRunView[] {
  const key = executionKeyString(record.key);

  return runs.some((run) => executionKeyString(run.key) === key)
    ? runs.map((run) => (executionKeyString(run.key) === key ? record : run))
    : [...runs, record]
        .sort((a, b) => (executionKeyString(a.key) < executionKeyString(b.key) ? -1 : 1))
        .slice(0, SNAPSHOT_RECORD_LIMIT);
}

function newer(current: RunView, next: RunView): boolean {
  return next.updatedAt >= current.updatedAt;
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

function applyHookToList(runs: RunView[], event: HookEvent): RunView[] {
  return runs.map((run) =>
    run.id === event.record.runId && event.at >= run.updatedAt
      ? { ...run, waitingOn: waitingAfter(run, event) }
      : run,
  );
}

type BatchChanges = {
  lists: Set<string>;
  loopies: boolean;
  schedules: boolean;
  scheduleOverview: boolean;
  derived: Set<string>;
};

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
    (filters.workspace === undefined || filters.workspace === run.workspace) &&
    (filters.from === undefined || run.createdAt >= filters.from) &&
    (filters.to === undefined || run.createdAt < filters.to) &&
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
    list === undefined || Array.isArray(list)
      ? [list ?? []]
      : "runs" in list
        ? [list.runs]
        : list.pages.map((page) => page.runs);

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

  remember(runs, event.record.id, { sequence: event.sequence, run: event.record });
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
  const seen = histories.get(client)?.runs.get(run.id)?.run;

  for (const query of client.getQueryCache().findAll({ queryKey: keys.runLists })) {
    const key = query.queryKey;

    if (key[0] !== "runs" || key[1] === undefined) {
      continue;
    }

    const filters = key[1] === "pages" || key[1] === "page" ? key[2] : key[1];
    const list = client.getQueryData<RunList>(key);
    const previous = listRun(list, run.id);

    if (write !== undefined && !acceptListRun(previous, query, write)) {
      continue;
    }

    if (previous !== undefined) {
      client.setQueryData<RunList>(key, (current) =>
        mapRunList(current, (runs) => replaceMember(runs, run, filters)),
      );
    }

    // A fetch in flight read the server before this write. If the run could have matched the
    // list then, its answer would bring back the older row, so the refetch restarts. A created
    // run did not exist yet. Any other run the session has never seen might have matched, which
    // bounds those extra restarts to one per run.
    const before = previous ?? seen;

    const stale =
      query.state.fetchStatus === "fetching" &&
      (before === undefined ? write?.event.kind !== "created" : matchesRun(filters, before));

    if (stale || (previous === undefined && matchesRun(filters, run))) {
      missing.add(query.queryHash);
    }
  }

  return missing;
}

function applyHookLists({ client }: BatchContext, event: HookEvent): void {
  for (const query of client.getQueryCache().findAll({ queryKey: keys.runLists })) {
    client.setQueryData<RunList>(query.queryKey, (current) =>
      mapRunList(current, (runs) => applyHookToList(runs, event)),
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
  remember(history.runs, event.record.id, { sequence: event.sequence, run: event.record });
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

  remember(history.sequences, identity, event.sequence);

  return true;
}

function applyEvent(context: BatchContext, event: ServerEvent): void {
  const { client, history, changes } = context;

  if (event.entity === "run") {
    applyRunEvent(context, event);

    if (!acceptEvent(history, event)) {
      return;
    }
  } else if (!acceptEvent(history, event)) {
    return;
  }

  for (const query of client.getQueryCache().getAll()) {
    const [kind, id] = query.queryKey;

    const feed =
      query.meta?.live !== false &&
      (kind === "event-history" || (kind === "logs" && event.entity === "log"));

    const payload =
      kind === "run-payload" &&
      id === event.runId &&
      event.entity === "run" &&
      event.kind !== "heartbeat";

    const overview = kind === "overview" && event.entity === "run" && event.kind !== "heartbeat";

    const scoped =
      event.entity === "node" &&
      id === event.runId &&
      (kind === "executions" ||
        kind === "execution" ||
        kind === "scope-items" ||
        kind === "scopes" ||
        (kind === "run" && event.record.key.scope.length > 0));

    if (feed || overview || scoped || payload) {
      changes.derived.add(query.queryHash);
    }
  }

  if (event.entity === "schedule") {
    changes.loopies = true;
    changes.scheduleOverview = true;
    const applied = applyScheduleEvent(client, event);
    changes.schedules ||= !applied;

    return;
  }

  if (event.entity === "hook") {
    applyHookLists(context, event);
  }

  if (event.runId !== null) {
    client.setQueryData<RunSnapshotView>(
      keys.run(event.runId),
      (current) => current && applyToSnapshot(current, event),
    );
  }
}

/**
 * Refetches lists by query hash. TanStack's refetch cancels a fetch in flight only when the
 * query already holds data (`Query.fetch` with `cancelRefetch`). A first load would instead
 * keep its fetch, which read the server before the event. The silent cancel followed by a
 * fetch is the same restart TanStack applies to a list with data, so a loader awaiting the
 * first load receives the new answer.
 */
function refetchLists(client: QueryClient, hashes: Set<string>): void {
  if (hashes.size === 0) {
    return;
  }

  for (const hash of hashes) {
    const query = client.getQueryCache().get(hash);

    if (query?.state.data === undefined && query?.state.fetchStatus === "fetching") {
      void query.cancel({ silent: true });
      void query.fetch().catch(() => {});
    }
  }

  void client.invalidateQueries({
    queryKey: keys.runLists,
    predicate: (query) => hashes.has(query.queryHash),
  });
}

// Stream bursts mark data stale immediately and refresh active observers together.
const refreshes = new WeakMap<
  QueryClient,
  { hashes: Set<string>; timer: ReturnType<typeof setTimeout> }
>();

function refreshDerived(client: QueryClient, hashes: Set<string>): void {
  if (hashes.size === 0) {
    return;
  }

  void client.invalidateQueries({
    predicate: (query) => hashes.has(query.queryHash),
    refetchType: "none",
  });
  const pending = refreshes.get(client);

  if (pending) {
    for (const hash of hashes) {
      pending.hashes.add(hash);
    }

    return;
  }

  const timer = setTimeout(() => {
    refreshes.delete(client);
    void client.refetchQueries({
      type: "active",
      predicate: (query) => hashes.has(query.queryHash),
    });
  }, REFRESH_DELAY_MS);

  refreshes.set(client, { hashes, timer });
}

/** Writes a transaction before refetching each affected list once. */
export function applyBatch(client: QueryClient, batch: ServerEvent[]): void {
  const history = histories.get(client) ?? {
    sequences: new Map(),
    runs: new Map(),
    lists: new WeakMap(),
  };

  histories.set(client, history);

  const changes: BatchChanges = {
    lists: new Set(),
    loopies: false,
    schedules: false,
    scheduleOverview: false,
    derived: new Set(),
  };

  for (const event of batch) {
    const bounded = event.entity === "run" ? { ...event, record: previewRun(event.record) } : event;
    applyEvent({ client, history, changes }, bounded);
  }

  refetchLists(client, changes.lists);
  refreshDerived(client, changes.derived);

  if (changes.loopies) {
    void client.invalidateQueries({ queryKey: keys.loopies });
  }

  if (changes.scheduleOverview) {
    void client.invalidateQueries({ queryKey: keys.scheduleOverview });
  }

  if (changes.schedules) {
    void client.invalidateQueries({ queryKey: keys.scheduleLists });
  }
}

function sameSchedule(a: ScheduleId, b: ScheduleId): boolean {
  return a.workspace === b.workspace && a.slug === b.slug;
}

/** A lower version is older than what the list holds; a fire keeps the version it fired. */
function withSchedule(list: ScheduleView[], next: ScheduleView): ScheduleView[] {
  const current = list.find((item) => sameSchedule(item, next));

  if (
    current &&
    (current.version > next.version ||
      (current.version === next.version && current.nextFireAt >= next.nextFireAt))
  ) {
    return list;
  }

  return current
    ? list.map((item) => (item === current ? next : item))
    : [...list, next].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Unseen schedules refetch their workspace list to retain server ordering. */
function applyScheduleEvent(client: QueryClient, event: ScheduleEvent): boolean {
  const list = client.getQueryData<ScheduleView[]>(keys.schedules(event.record.workspace));

  if (list === undefined) {
    return true;
  }

  if (event.kind === "deleted") {
    client.setQueryData<ScheduleView[]>(keys.schedules(event.record.workspace), (current) =>
      current?.filter((item) => !sameSchedule(item, event.record)),
    );

    return true;
  }

  if (!list.some((item) => sameSchedule(item, event.record))) {
    return false;
  }

  const view = { ...event.record, lastFireKey: event.record.lastFireKey ?? null };
  client.setQueryData<ScheduleView[]>(
    keys.schedules(view.workspace),
    (current) => current && withSchedule(current, view),
  );

  return true;
}

/** Writes a schedule returned by a mutation. It belongs to the listed workspace, so it may insert. */
export function applyScheduleView(client: QueryClient, view: ScheduleView): void {
  client.setQueryData<ScheduleView[]>(
    keys.schedules(view.workspace),
    (current) => current && withSchedule(current, view),
  );
  void client.invalidateQueries({ queryKey: keys.loopies });
  void client.invalidateQueries({ queryKey: keys.scheduleOverview });
}

export function removeScheduleView(client: QueryClient, identity: ScheduleId): void {
  client.setQueryData<ScheduleView[]>(keys.schedules(identity.workspace), (current) =>
    current?.filter((item) => !sameSchedule(item, identity)),
  );
  void client.invalidateQueries({ queryKey: keys.loopies });
  void client.invalidateQueries({ queryKey: keys.scheduleOverview });
}

/** Writes a run returned by a mutation; the stream later confirms or supersedes it. */
export function applyRunView(client: QueryClient, run: RunView): void {
  client.setQueryData<RunSnapshotView>(
    keys.run(run.id),
    (snapshot) => snapshot && (newer(snapshot.run, run) ? { ...snapshot, run } : snapshot),
  );

  refetchLists(client, updateMembership(client, run));
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
    const pending = refreshes.get(client);

    if (pending) {
      clearTimeout(pending.timer);
      refreshes.delete(client);
    }

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
