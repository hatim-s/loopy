import type { RunSnapshotView, ServerEvent } from "@loopy/contract";
import type { QueryClient } from "@tanstack/react-query";
import type { Refresh } from "../keys";
import { keys } from "../keys";
import { forgetHistory, historyOf, remember, type StreamHistory } from "./history";
import { applyHookToLists, applyRunEvent, refetchLists } from "./run-lists";
import { applyScheduleEvent } from "./schedules";
import { applyToSnapshot } from "./snapshot";

const REFRESH_DELAY_MS = 250;

type BatchChanges = {
  lists: Set<string>;
  loopies: boolean;
  schedules: boolean;
  scheduleOverview: boolean;
  derived: Set<string>;
};

function refreshes(refresh: Refresh | undefined, event: ServerEvent): boolean {
  switch (refresh?.on) {
    case undefined: {
      return false;
    }

    case "feed": {
      return true;
    }

    case "log": {
      return event.entity === "log";
    }

    case "run": {
      return (
        event.entity === "run" &&
        event.kind !== "heartbeat" &&
        (refresh.runId === null || refresh.runId === event.runId)
      );
    }

    case "node": {
      return event.entity === "node" && event.runId === refresh.runId;
    }
  }
}

function acceptEvent(history: StreamHistory, event: ServerEvent): boolean {
  const identity =
    event.entity === "schedule"
      ? `schedule:${event.record.workspace}:${event.record.slug}`
      : event.runId;

  if (identity === null || event.sequence <= (history.sequences.get(identity) ?? -1)) {
    return false;
  }

  remember(history.sequences, identity, event.sequence);

  return true;
}

function applyEvent(client: QueryClient, changes: BatchChanges, event: ServerEvent): void {
  // List membership has its own replay fence per list, so it sees run events before the
  // per-run fence below can drop them.
  if (event.entity === "run") {
    const { missing, statusChanged } = applyRunEvent(client, event);

    for (const hash of missing) {
      changes.lists.add(hash);
    }

    changes.loopies ||= statusChanged;
  }

  if (!acceptEvent(historyOf(client), event)) {
    return;
  }

  for (const query of client.getQueryCache().getAll()) {
    if (refreshes(query.meta?.refresh, event)) {
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
    applyHookToLists(client, event);
  }

  if (event.runId !== null) {
    client.setQueryData<RunSnapshotView>(
      keys.run(event.runId),
      (current) => current && applyToSnapshot(current, event),
    );
  }
}

// Stream bursts mark data stale at once and refresh active observers together.
const pendingRefreshes = new WeakMap<
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
  const pending = pendingRefreshes.get(client);

  if (pending) {
    for (const hash of hashes) {
      pending.hashes.add(hash);
    }

    return;
  }

  const timer = setTimeout(() => {
    pendingRefreshes.delete(client);
    void client.refetchQueries({
      type: "active",
      predicate: (query) => hashes.has(query.queryHash),
    });
  }, REFRESH_DELAY_MS);

  pendingRefreshes.set(client, { hashes, timer });
}

export function applyBatch(client: QueryClient, batch: ServerEvent[]): void {
  const changes: BatchChanges = {
    lists: new Set(),
    loopies: false,
    schedules: false,
    scheduleOverview: false,
    derived: new Set(),
  };

  for (const event of batch) {
    applyEvent(client, changes, event);
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

/** Drops what this cache session applied, so a new session starts from a fresh cursor. */
export function resetStream(client: QueryClient): void {
  forgetHistory(client);
  const pending = pendingRefreshes.get(client);

  if (pending) {
    clearTimeout(pending.timer);
    pendingRefreshes.delete(client);
  }
}
