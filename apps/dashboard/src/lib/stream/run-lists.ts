import type { RunSnapshotView, RunView, ServerEvent } from "@loopy/contract";
import type { Query, QueryClient } from "@tanstack/react-query";
import type { RunsQuery } from "../../backend/backend";
import { keys } from "../keys";
import type { RunPage } from "../queries";
import { historyOf, remember, type SeenRun, type StreamHistory, seenRun } from "./history";
import { type HookEvent, newer, waitingAfter } from "./snapshot";

export type RunEvent = Extract<ServerEvent, { entity: "run" }>;

type ListWrite = { history: StreamHistory; event: RunEvent };

function cachedLists(client: QueryClient) {
  return client
    .getQueryCache()
    .findAll({ queryKey: keys.runLists })
    .flatMap((query) => {
      const key = query.queryKey;

      return key[0] === "runs" && key.length === 2 ? [{ query, key, filters: key[1] }] : [];
    });
}

function mapPage(page: RunPage | undefined, update: (runs: RunView[]) => RunView[]) {
  return page && { ...page, runs: update(page.runs) };
}

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

function acceptListRun(previous: RunView | undefined, query: Query, write: ListWrite): boolean {
  const { history, event } = write;
  const runs = history.lists.get(query) ?? new Map<string, SeenRun>();
  const saved = runs.get(event.record.id);
  const current = previous ?? saved?.run;

  if (
    event.sequence <= (saved?.sequence ?? -1) ||
    (current !== undefined && !newer(current, event.record))
  ) {
    return false;
  }

  remember(runs, event.record.id, { sequence: event.sequence, run: event.record });
  history.lists.set(query, runs);

  return true;
}

/** Patches every cached list holding the run and returns the lists that must refetch. */
export function updateMembership(
  client: QueryClient,
  run: RunView,
  write?: ListWrite,
): Set<string> {
  const missing = new Set<string>();
  const seen = seenRun(client, run.id);

  for (const { query, key, filters } of cachedLists(client)) {
    const previous = client.getQueryData<RunPage>(key)?.runs.find((item) => item.id === run.id);

    if (write !== undefined && !acceptListRun(previous, query, write)) {
      continue;
    }

    if (previous !== undefined) {
      client.setQueryData<RunPage>(key, (current) =>
        mapPage(current, (runs) => replaceMember(runs, run, filters)),
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

export function applyHookToLists(client: QueryClient, event: HookEvent): void {
  for (const { key } of cachedLists(client)) {
    client.setQueryData<RunPage>(key, (current) =>
      mapPage(current, (runs) =>
        runs.map((run) =>
          run.id === event.record.runId && event.at >= run.updatedAt
            ? { ...run, waitingOn: waitingAfter(run, event) }
            : run,
        ),
      ),
    );
  }
}

/**
 * Refetches lists by query hash. TanStack's refetch cancels a fetch in flight only when the
 * query already holds data (`Query.fetch` with `cancelRefetch`). A first load would instead
 * keep its fetch, which read the server before the event. The silent cancel followed by a
 * fetch is the same restart TanStack applies to a list with data, so a loader awaiting the
 * first load receives the new answer. A failed restart surfaces on the query like any fetch.
 */
export function refetchLists(client: QueryClient, hashes: Set<string>): void {
  if (hashes.size === 0) {
    return;
  }

  for (const hash of hashes) {
    const query = client.getQueryCache().get(hash);

    if (query?.state.data === undefined && query?.state.fetchStatus === "fetching") {
      void query.cancel({ silent: true });
      void query.fetch().catch(() => undefined);
    }
  }

  void client.invalidateQueries({
    queryKey: keys.runLists,
    predicate: (query) => hashes.has(query.queryHash),
  });
}

/** Records a run event in the session history and reports whether its status changed. */
export function applyRunEvent(client: QueryClient, event: RunEvent) {
  const history = historyOf(client);
  const missing = updateMembership(client, event.record, { history, event });

  if (event.kind === "heartbeat") {
    return { missing: new Set<string>(), statusChanged: false };
  }

  const previous = history.runs.get(event.record.id);

  if (
    previous !== undefined &&
    (event.sequence <= previous.sequence || !newer(previous.run, event.record))
  ) {
    return { missing, statusChanged: false };
  }

  remember(history.runs, event.record.id, { sequence: event.sequence, run: event.record });

  return { missing, statusChanged: previous?.run.status !== event.record.status };
}

export function applyRunView(client: QueryClient, run: RunView): void {
  client.setQueryData<RunSnapshotView>(
    keys.run(run.id),
    (snapshot) => snapshot && (newer(snapshot.run, run) ? { ...snapshot, run } : snapshot),
  );

  refetchLists(client, updateMembership(client, run));
  void client.invalidateQueries({ queryKey: keys.loopies });
}
