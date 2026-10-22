import {
  type DaemonView,
  encodeRunCursor,
  executionKeyString,
  type GraphRevisionView,
  type HookRecord,
  isTerminalRun,
  type LogRecord,
  type LoopyView,
  type NodeRunView,
  type PutScheduleBody,
  type RunSnapshotView,
  type RunStatus,
  type RunView,
  routes,
  type ScheduleView,
  type ServerEvent,
} from "loopy/contract";
import { applyToSnapshot } from "../lib/stream.ts";
import { BackendError, type EventSubscription, type LoopyBackend } from "./backend.ts";

type Draft<E> = E extends ServerEvent ? Omit<E, "sequence" | "at" | "txn"> : never;

/** An event before the fake stamps its sequence, time and transaction. */
export type EventDraft = Draft<ServerEvent>;

export type FakeScript = {
  epoch: string;
  loopies: LoopyView[];
  /** Runs as they stand before the first batch plays. */
  runs: RunSnapshotView[];
  schedules: ScheduleView[];
  /** Every saved revision. The last one named after a loopy is its latest definition. */
  graphs: GraphRevisionView[];
  /** The revision each scripted run pinned, keyed by run id. */
  pins: Record<string, string>;
  /** Played in order. A batch that creates a hook holds playback until it is resolved. */
  batches: EventDraft[][];
  intervalMs: number;
};

function scheduleKey(workspace: string, slug: string): string {
  return JSON.stringify([workspace, slug]);
}

const HOUR_MS = 3_600_000;

/** An in-memory backend that plays a scripted run, for tests and `VITE_BACKEND=fake`. */
export function fakeBackend(script: FakeScript): LoopyBackend {
  const snapshots = new Map(script.runs.map((snapshot) => [snapshot.run.id, snapshot]));

  const schedules = new Map(
    script.schedules.map((schedule) => [scheduleKey(schedule.workspace, schedule.slug), schedule]),
  );

  const pending = [...script.batches];
  const released: ServerEvent[][] = [];
  const listeners = new Set<(batch: ServerEvent[]) => void>();
  let sequence = Math.max(0, ...script.runs.map((snapshot) => snapshot.cursor));
  let held = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function snapshot(id: string): RunSnapshotView {
    const found = snapshots.get(id);

    if (!found) {
      throw new BackendError("not_found");
    }

    return found;
  }

  /** Stamps and delivers one transaction without touching playback. */
  function publish(drafts: EventDraft[]): ServerEvent[] {
    const txn = `txn-${released.length + 1}`;
    const at = new Date().toISOString();

    const batch = drafts.map((draft): ServerEvent => {
      const event = { ...draft, sequence: ++sequence, at, txn };

      return event.entity === "run"
        ? { ...event, record: { ...event.record, updatedAt: at } }
        : event;
    });

    for (const event of batch) {
      const target = event.runId === null ? undefined : snapshots.get(event.runId);

      if (target) {
        snapshots.set(target.run.id, applyToSnapshot(target, event));
      }
    }

    released.push(batch);

    for (const listener of listeners) {
      listener(batch);
    }

    return batch;
  }

  function release(drafts: EventDraft[]): void {
    held = publish(drafts).some((event) => event.entity === "hook" && event.kind === "created");
  }

  function revision(id: string | undefined, missing: string): GraphRevisionView {
    const found = script.graphs.find((view) => view.revision === id);

    if (!found) {
      throw new BackendError("not_found", missing);
    }

    return found;
  }

  function schedule(slug: string, workspace: string): ScheduleView {
    const found = schedules.get(scheduleKey(workspace, slug));

    if (!found) {
      throw new BackendError("not_found");
    }

    return found;
  }

  function saveSchedule(view: ScheduleView): ScheduleView {
    const saved = { ...view, version: view.version + 1 };
    const { lastFireKey, ...record } = saved;
    schedules.set(scheduleKey(saved.workspace, saved.slug), saved);
    publish([
      {
        entity: "schedule",
        kind: "saved",
        runId: null,
        record: lastFireKey === null ? record : { ...record, lastFireKey },
      },
    ]);

    return saved;
  }

  /** The fake has no cron engine: a new schedule fires in an hour and edits keep the time. */
  function newSchedule(slug: string, workspace: string, body: PutScheduleBody): ScheduleView {
    const declared = script.loopies.find(
      (loopy) => loopy.slug === slug && loopy.workspace === workspace,
    )?.schedule;

    const cron = body.cron ?? declared?.cron;

    if (!cron) {
      throw new BackendError("invalid_schedule", `No schedule for '${slug}'. Pass a cron.`);
    }

    return {
      workspace,
      slug,
      cron,
      tz: body.tz ?? declared?.tz ?? "UTC",
      enabled: true,
      input: {},
      nextFireAt: new Date(Date.now() + HOUR_MS).toISOString(),
      lastFireKey: null,
      version: 0,
    };
  }

  function play(): void {
    if (listeners.size === 0 || timer !== undefined || held || pending.length === 0) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      const next = pending.shift();

      if (next) {
        release(next);
      }

      play();
    }, script.intervalMs);
  }

  function changeRun(id: string, kind: "woken" | "finished", run: RunView): RunView {
    release([{ entity: "run", kind, runId: id, record: run }]);

    return snapshot(id).run;
  }

  function pendingHook(token: string): HookRecord {
    for (const { hooks } of snapshots.values()) {
      const hook = hooks.find((item) => item.token === token);

      if (hook && hook.resolvedAt === undefined && hook.expiredAt === undefined) {
        return hook;
      }
    }

    throw new BackendError("unknown_hook");
  }

  function matchesRun(
    run: RunView,
    query: {
      slug?: string;
      workspace?: string;
      status?: RunStatus;
      runId?: string;
      from?: string;
      to?: string;
    },
  ): boolean {
    return (
      (query.slug === undefined || run.slug === query.slug) &&
      (query.workspace === undefined || run.workspace === query.workspace) &&
      (query.status === undefined || run.status === query.status) &&
      (query.runId === undefined || run.id === query.runId) &&
      (query.from === undefined || run.createdAt >= query.from) &&
      (query.to === undefined || run.createdAt < query.to)
    );
  }

  function nodes(id: string): NodeRunView[] {
    const records = new Map(
      script.runs
        .find((item) => item.run.id === id)
        ?.nodeRuns.map((node) => [executionKeyString(node.key), node]),
    );

    for (const event of released.flat()) {
      if (event.entity === "node" && event.runId === id) {
        records.set(executionKeyString(event.record.key), event.record);
      }
    }

    return [...records.values()].sort((a, b) =>
      executionKeyString(a.key).localeCompare(executionKeyString(b.key)),
    );
  }

  function fakeLogs() {
    const logs = new Map<string, { run: RunView; log: LogRecord }>();

    for (const initial of script.runs) {
      for (const log of initial.logs) {
        logs.set(`${log.runId}:${log.seq}`, { run: snapshot(log.runId).run, log });
      }
    }

    for (const event of released.flat()) {
      if (event.entity === "log") {
        logs.set(`${event.record.runId}:${event.record.seq}`, {
          run: snapshot(event.record.runId).run,
          log: event.record,
        });
      }
    }

    return [...logs.values()]
      .sort(
        (a, b) =>
          a.log.at.localeCompare(b.log.at) ||
          a.run.id.localeCompare(b.run.id) ||
          a.log.seq - b.log.seq,
      )
      .map((row, index) => ({ ...row, id: index + 1 }));
  }

  function logNodeId(log: LogRecord): string {
    const position = log.position;

    return position.kind === "node"
      ? (nodes(log.runId).find((node) => executionKeyString(node.key) === position.executionKey)
          ?.key.nodeId ?? "")
      : "";
  }

  function pageBounds(ids: number[], selected: number[], limit: number) {
    return {
      next: selected.length === limit ? (selected.at(-1) ?? null) : null,
      hasMore: selected.length === limit,
      scanned: selected.length,
      oldest: ids[0] ?? null,
      newest: ids.at(-1) ?? null,
    };
  }

  const daemon: DaemonView = {
    pid: 4242,
    startedAt: new Date().toISOString(),
    concurrency: 4,
    running: 1,
    nextWakeAt: null,
  };

  return {
    cursor: async () => ({ cursor: sequence, epoch: script.epoch }),
    loopies: async (workspace) => {
      const definitions =
        workspace === undefined
          ? script.loopies
          : [
              ...script.loopies.filter((loopy) => loopy.workspace === workspace),
              ...script.loopies.filter((loopy) => loopy.workspace !== workspace),
            ].filter(
              (loopy, index, all) => all.findIndex((row) => row.slug === loopy.slug) === index,
            );

      return definitions.map((loopy) => {
        const counts = { ...loopy.counts };

        // Counts follow the played runs, the way the server derives them from its store.
        for (const { run } of snapshots.values()) {
          counts[run.status] += run.slug === loopy.slug ? 1 : 0;
        }

        return {
          ...loopy,
          counts,
          latestRuns: [...snapshots.values()]
            .flatMap(({ run }) =>
              run.slug === loopy.slug && run.workspace === loopy.workspace ? [run] : [],
            )
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, 10),
          lastRun: loopy.lastRun && (snapshots.get(loopy.lastRun.id)?.run ?? loopy.lastRun),
        };
      });
    },
    runs: async (query) => {
      const { slug, workspace, status, waiting, limit, before, from, to } =
        routes.runs.query.parse(query);

      return [...snapshots.values()]
        .flatMap(({ run }) =>
          (slug ?? run.slug) === run.slug &&
          (status ?? run.status) === run.status &&
          (workspace === undefined || workspace === run.workspace) &&
          (from === undefined || run.createdAt >= from) &&
          (to === undefined || run.createdAt < to) &&
          (waiting === undefined || (run.waitingOn !== null) === waiting) &&
          (before === undefined || encodeRunCursor(run) < before)
            ? [run]
            : [],
        )
        .sort((a, b) => (encodeRunCursor(a) < encodeRunCursor(b) ? 1 : -1))
        .slice(0, limit);
    },
    loopyGraph: async (slug, workspace) =>
      revision(
        script.loopies.some((loopy) => loopy.slug === slug && loopy.workspace === workspace)
          ? script.graphs.filter((view) => view.graph.name === slug).at(-1)?.revision
          : undefined,
        `No saved graph for '${slug}' in ${workspace}.`,
      ),
    run: async (id) => snapshot(id),
    runGraph: async (id) =>
      revision(script.pins[snapshot(id).run.id], `The graph run '${id}' pinned is missing.`),
    logs: async (id, after) => snapshot(id).logs.filter((log) => log.seq > after),
    startRun: async () => {
      throw new BackendError("bad_request", "The fake backend only plays its script.");
    },
    resumeRun: async (id) => {
      const { run } = snapshot(id);

      if (isTerminalRun(run.status)) {
        throw new BackendError("not_claimable");
      }

      if (run.owner !== null && !run.ownerStale) {
        throw new BackendError("owned_elsewhere");
      }

      const woken = changeRun(id, "woken", { ...base(run), status: "queued" });
      held = false;
      play();

      return woken;
    },
    cancelRun: async (id) => {
      const { run } = snapshot(id);

      if (isTerminalRun(run.status)) {
        throw new BackendError("not_claimable");
      }

      pending.length = 0;
      clearTimeout(timer);
      timer = undefined;

      return changeRun(id, "finished", { ...base(run), status: "cancelled", owner: null });
    },
    resolveHook: async (token, payload) => {
      const hook = pendingHook(token);
      const { run } = snapshot(hook.runId);
      const resolvedAt = new Date().toISOString();

      release([
        {
          entity: "hook",
          kind: "resolved",
          runId: run.id,
          record: { ...hook, payload, resolvedAt },
        },
        {
          entity: "run",
          kind: "woken",
          runId: run.id,
          record: { ...base(run), status: "queued", waitingOn: null, updatedAt: resolvedAt },
        },
      ]);

      play();

      return snapshot(run.id).run;
    },
    daemon: async () => daemon,
    scheduleOverview: async () => {
      const all = [...schedules.values()];
      const active = all.filter((schedule) => schedule.enabled);

      return {
        workspaces: [...new Set(all.map((schedule) => schedule.workspace))].sort(),
        active: active.length,
        next: active
          .sort(
            (a, b) =>
              a.nextFireAt.localeCompare(b.nextFireAt) ||
              a.workspace.localeCompare(b.workspace) ||
              a.slug.localeCompare(b.slug),
          )
          .slice(0, 10)
          .map(({ workspace, slug, cron, tz, nextFireAt }) => ({
            workspace,
            slug,
            cron,
            tz,
            nextFireAt,
          })),
      };
    },
    schedules: async (workspace) =>
      [...schedules.values()].filter((view) => view.workspace === workspace),
    putSchedule: async (slug, workspace, body) =>
      saveSchedule({
        ...(schedules.get(scheduleKey(workspace, slug)) ?? newSchedule(slug, workspace, body)),
        ...body,
      }),
    setScheduleEnabled: async (slug, workspace, enabled) =>
      saveSchedule({ ...schedule(slug, workspace), enabled }),
    deleteSchedule: async (slug, workspace) => {
      const existing = schedules.get(scheduleKey(workspace, slug));

      if (existing) {
        schedules.delete(scheduleKey(workspace, slug));
        publish([
          {
            entity: "schedule",
            kind: "deleted",
            runId: null,
            record: { workspace: existing.workspace, slug },
          },
        ]);
      }

      return { deleted: true };
    },
    overview: async (input) => {
      const query = routes.overview.query.parse(input);

      const zero = () => ({
        queued: 0,
        running: 0,
        suspended: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      });

      const counts = zero();
      const start = Date.parse(query.from);
      const width = query.bucketSeconds * 1000;

      const buckets = Array.from(
        Array.from({ length: Math.ceil((Date.parse(query.to) - start) / width) }).keys(),
        (index) => ({ at: new Date(start + index * width).toISOString(), counts: zero() }),
      );

      for (const { run } of snapshots.values()) {
        if (matchesRun(run, query)) {
          counts[run.status]++;
          const bucket = buckets[Math.floor((Date.parse(run.createdAt) - start) / width)];

          if (bucket) {
            bucket.counts[run.status]++;
          }
        }
      }

      return {
        from: query.from,
        to: query.to,
        bucketSeconds: query.bucketSeconds,
        counts,
        buckets,
      };
    },
    source: async (slug, workspace) => ({
      version: 1,
      status: "unavailable",
      revision: revision(
        script.loopies.some((loopy) => loopy.slug === slug && loopy.workspace === workspace)
          ? script.graphs.filter((view) => view.graph.name === slug).at(-1)?.revision
          : undefined,
        "No saved graph.",
      ).revision,
      reason: "not_captured",
    }),
    runSource: async (id) => ({
      version: 1,
      status: "unavailable",
      revision: revision(script.pins[snapshot(id).run.id], "No pinned graph.").revision,
      reason: "not_captured",
    }),
    runPayload: async (id) => {
      const { run } = snapshot(id);

      return run.status === "succeeded"
        ? { input: run.input, output: run.output }
        : { input: run.input };
    },
    scopes: async (id, input) => {
      const query = routes.scopes.query.parse(input);
      const parent: NodeRunView["key"]["scope"] = JSON.parse(query.parentScope);

      const groups = new Map<
        string,
        { indices: Set<number>; counts: Partial<Record<NodeRunView["status"], number>> }
      >();

      for (const node of nodes(id)) {
        const tuple = node.key.scope[parent.length];

        if (
          !tuple ||
          node.key.scope.length !== parent.length + 1 ||
          JSON.stringify(node.key.scope.slice(0, parent.length)) !== query.parentScope
        ) {
          continue;
        }

        const group = groups.get(tuple.nodeId) ?? { indices: new Set<number>(), counts: {} };
        group.indices.add(tuple.index);
        group.counts[node.status] = (group.counts[node.status] ?? 0) + 1;
        groups.set(tuple.nodeId, group);
      }

      return [...groups].map(([nodeId, group]) => ({
        nodeId,
        parentScope: parent,
        total: group.indices.size,
        counts: group.counts,
      }));
    },
    executions: async (id, input) => {
      const query = routes.executions.query.parse(input);

      const items = nodes(id)
        .filter(
          (node) =>
            JSON.stringify(node.key.scope) === query.scope &&
            (query.nodeId === undefined || node.key.nodeId === query.nodeId) &&
            (query.status === undefined || node.status === query.status) &&
            (query.after === undefined || executionKeyString(node.key) > query.after),
        )
        .slice(0, query.limit);

      return {
        items,
        next:
          items.length === query.limit && items.at(-1)
            ? executionKeyString(items[items.length - 1]!.key)
            : null,
        truncatedOutputs: {},
      };
    },
    execution: async (id, query) => {
      const node = nodes(id).find((record) => executionKeyString(record.key) === query.key);

      if (!node) {
        throw new BackendError("not_found");
      }

      return { node, attempts: [node], attemptsNext: null };
    },
    scopeItems: async (id, input) => {
      const query = routes.scopeItems.query.parse(input);
      const parent: NodeRunView["key"]["scope"] = JSON.parse(query.parentScope);

      const items = new Map<
        number,
        { index: number; counts: Partial<Record<NodeRunView["status"], number>> }
      >();

      for (const node of nodes(id)) {
        const tuple = node.key.scope[parent.length];

        if (
          node.key.scope.length !== parent.length + 1 ||
          !tuple ||
          tuple.nodeId !== query.nodeId ||
          JSON.stringify(node.key.scope.slice(0, parent.length)) !== query.parentScope ||
          (query.after !== undefined && tuple.index <= query.after)
        ) {
          continue;
        }

        const row = items.get(tuple.index) ?? { index: tuple.index, counts: {} };
        row.counts[node.status] = (row.counts[node.status] ?? 0) + 1;
        items.set(tuple.index, row);
      }

      const rows = [...items.values()]
        .filter((row) => query.status === undefined || (row.counts[query.status] ?? 0) > 0)
        .sort((a, b) => a.index - b.index)
        .slice(0, query.limit);

      return {
        items: rows,
        next: rows.length === query.limit ? (rows.at(-1)?.index ?? null) : null,
      };
    },
    globalLogs: async (input) => {
      const query = routes.globalLogs.query.parse(input);
      const all = fakeLogs();

      const selected = all
        .filter(
          ({ id, log, run }) =>
            matchesRun(run, { ...query, from: undefined, to: undefined }) &&
            (query.before === undefined || id < query.before) &&
            (query.after === undefined || id > query.after) &&
            (query.nodeId === undefined || logNodeId(log) === query.nodeId) &&
            (query.executionKey === undefined ||
              (log.position.kind === "node" && log.position.executionKey === query.executionKey)) &&
            (query.level === undefined || log.level === query.level) &&
            (query.text === undefined || log.message.includes(query.text)) &&
            (query.from === undefined || log.at >= query.from) &&
            (query.to === undefined || log.at < query.to),
        )
        .sort((a, b) => (query.after === undefined ? b.id - a.id : a.id - b.id))
        .slice(0, query.limit);

      return {
        ...pageBounds(
          all.map((row) => row.id),
          selected.map((row) => row.id),
          query.limit,
        ),
        items: selected.map(({ id, log, run }) => ({
          id,
          runId: run.id,
          slug: run.slug,
          seq: log.seq,
          at: log.at,
          nodeId: logNodeId(log),
          executionKey: log.position.kind === "node" ? log.position.executionKey : "",
          attempt: log.position.kind === "node" ? log.position.attempt : 1,
          level: log.level,
          message: log.message,
          dataBytes:
            log.data === undefined ? 0 : new TextEncoder().encode(JSON.stringify(log.data)).length,
        })),
      };
    },
    log: async (id) => {
      const row = fakeLogs().find((item) => item.id === id);

      if (!row) {
        throw new BackendError("not_found");
      }

      return { id, log: row.log };
    },
    eventHistory: async (input) => {
      const query = routes.eventHistory.query.parse(input);
      const all = released.flat();

      const selected = all
        .filter(
          (event) =>
            (query.before === undefined || event.sequence < query.before) &&
            (query.after === undefined || event.sequence > query.after) &&
            (query.entity === undefined || event.entity === query.entity) &&
            (query.kind === undefined || event.kind === query.kind) &&
            (query.txn === undefined || event.txn === query.txn) &&
            (query.slug === undefined ||
              (event.runId !== null && snapshot(event.runId).run.slug === query.slug)) &&
            (query.status === undefined ||
              (event.runId !== null && snapshot(event.runId).run.status === query.status)) &&
            (query.nodeId === undefined ||
              (event.entity === "node" && event.record.key.nodeId === query.nodeId)) &&
            (query.runId === undefined || event.runId === query.runId) &&
            (query.from === undefined || event.at >= query.from) &&
            (query.to === undefined || event.at < query.to),
        )
        .sort((a, b) =>
          query.after === undefined ? b.sequence - a.sequence : a.sequence - b.sequence,
        )
        .slice(0, query.limit);

      return {
        ...pageBounds(
          all.map((event) => event.sequence),
          selected.map((event) => event.sequence),
          query.limit,
        ),
        items: selected.map((event) => ({
          sequence: event.sequence,
          at: event.at,
          txn: event.txn,
          runId: event.runId,
          slug: event.runId ? (snapshots.get(event.runId)?.run.slug ?? null) : null,
          nodeId: event.entity === "node" ? event.record.key.nodeId : null,
          entity: event.entity,
          kind: event.kind,
        })),
      };
    },
    event: async (sequence) => {
      const found = released.flat().find((event) => event.sequence === sequence);

      if (!found) {
        throw new BackendError("not_found");
      }

      return found;
    },
    events: ({ after, epoch, signal, onBatch, onState }: EventSubscription) => {
      if (signal.aborted) {
        return Promise.resolve("aborted");
      }

      if (epoch !== script.epoch) {
        return Promise.resolve("reset");
      }

      return new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            listeners.delete(onBatch);

            if (listeners.size === 0) {
              clearTimeout(timer);
              timer = undefined;
            }

            resolve("aborted");
          },
          { once: true },
        );

        onState("live");

        for (const batch of released) {
          if (signal.aborted) {
            break;
          }

          const unseen = batch.filter((event) => event.sequence > after);

          if (unseen.length > 0) {
            onBatch(unseen);
          }
        }

        if (!signal.aborted) {
          listeners.add(onBatch);
          play();
        }
      });
    },
  };
}

/** The fields every run status shares, so a script can move a run to any status. */
export function base(run: RunView) {
  const { id, slug, workspace, loopy, input, createdAt, owner, ownerStale, waitingOn } = run;

  return {
    id,
    slug,
    workspace,
    loopy,
    input,
    createdAt,
    updatedAt: new Date().toISOString(),
    owner,
    ownerStale,
    waitingOn,
  };
}
