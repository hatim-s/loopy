import {
  type DaemonView,
  encodeRunCursor,
  type HookRecord,
  type LoopyView,
  type RunSnapshotView,
  type RunView,
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
  /** Played in order. A batch that creates a hook holds playback until it is resolved. */
  batches: EventDraft[][];
  intervalMs: number;
};

const ACTIVE = new Set<RunView["status"]>(["queued", "running", "suspended"]);

/** An in-memory backend that plays a scripted run, for tests and `VITE_BACKEND=fake`. */
export function fakeBackend(script: FakeScript): LoopyBackend {
  const snapshots = new Map(script.runs.map((snapshot) => [snapshot.run.id, snapshot]));
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

  function release(drafts: EventDraft[]): void {
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
    held = batch.some((event) => event.entity === "hook" && event.kind === "created");

    for (const listener of listeners) {
      listener(batch);
    }
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

  const daemon: DaemonView = {
    pid: 4242,
    startedAt: new Date().toISOString(),
    concurrency: 4,
    running: 1,
    nextWakeAt: null,
  };

  return {
    cursor: async () => ({ cursor: sequence, epoch: script.epoch }),
    loopies: async () =>
      script.loopies.map((loopy) => ({
        ...loopy,
        lastRun: loopy.lastRun && (snapshots.get(loopy.lastRun.id)?.run ?? loopy.lastRun),
      })),
    runs: async ({ slug, status, waiting, limit = 50, before }) =>
      [...snapshots.values()]
        .flatMap(({ run }) =>
          (slug ?? run.slug) === run.slug &&
          (status ?? run.status) === run.status &&
          (waiting === undefined || (run.waitingOn !== null) === waiting) &&
          (before === undefined || encodeRunCursor(run) < before)
            ? [run]
            : [],
        )
        .sort((a, b) => (encodeRunCursor(a) < encodeRunCursor(b) ? 1 : -1))
        .slice(0, limit),
    run: async (id) => snapshot(id),
    logs: async (id, after) => snapshot(id).logs.filter((log) => log.seq > after),
    startRun: async () => {
      throw new BackendError("bad_request", "The fake backend only plays its script.");
    },
    resumeRun: async (id) => {
      const { run } = snapshot(id);

      if (!ACTIVE.has(run.status)) {
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

      if (!ACTIVE.has(run.status)) {
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
