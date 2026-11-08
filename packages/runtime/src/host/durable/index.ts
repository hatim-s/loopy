import {
  type Graph,
  OwnershipError,
  type RunOutcome,
  type RunRecord,
  type Store,
} from "@loopy/core";
import { Effect } from "effect";
import { commitTurn, type HostWork, workId } from "../turn";
import type { DurableExecutionProvider } from "./provider";
import { durableWakeAt } from "./wake";
import { reconcileDurableWork } from "./work";

export { type DurableExecutionProvider, DurableProviderError } from "./provider";

export type DurableActivationOptions = {
  store: Store;
  graph: Graph;
  runId: string;
  provider: DurableExecutionProvider;
  /** Unique to the owning scheduler session. Keep it across turns, replace it on reconstruction. */
  token: string;
  at: string;
  /** Maximum dispatch/receipt checks and samples. Each can commit one completion transition. */
  maxWork: number;
  pollMs: number;
  /** Persist the returned cursor to fairly reconcile graphs wider than maxWork. */
  cursor?: string | null;
};

export type DurableActivationResult =
  | { status: "finished"; outcome: RunOutcome; nextWakeAt: null; cursor: null }
  | { status: "pending"; nextWakeAt: string; cursor: string | null }
  | { status: "suspended"; nextWakeAt: string | null; cursor: null };

function finished(run: RunRecord): DurableActivationResult | undefined {
  let outcome: RunOutcome;

  switch (run.status) {
    case "succeeded":
      outcome = { status: "succeeded", output: run.output };
      break;
    case "failed":
      outcome = { status: "failed", error: run.error };
      break;
    case "cancelled":
      outcome = { status: "cancelled" };
      break;
    default:
      return;
  }

  return { status: "finished", outcome, nextWakeAt: null, cursor: null };
}

function own(store: Store, run: RunRecord, token: string) {
  return Effect.gen(function* () {
    if (run.owner?.token === token) {
      // Recover a turn interrupted between committing suspension and releasing ownership.
      if (run.status === "suspended") {
        yield* store.release(run.id, token);

        return yield* store.claim(run.id, token);
      }

      if (!(yield* store.heartbeat(run.id, token))) {
        return yield* Effect.fail(new OwnershipError(run.id));
      }

      return run;
    }

    return yield* store.claim(run.id, token);
  });
}

/** The caller serializes turns and hook mutations, coordinates SQL transactions,
 * and persists scheduler metadata with an alarm before starting the turn. Pending
 * work retains ownership and a concurrency slot. On errors retain both and resume
 * reconciliation. A new owner session must wait for the Store lease to become stale.
 * No transaction may span provider calls. Providers must bound their own request time.
 */
export function activateDurable(options: DurableActivationOptions) {
  return Effect.gen(function* () {
    const { store, graph, runId, token, at, maxWork, pollMs } = options;
    const stored = yield* store.getRun(runId);

    if (!stored) {
      return yield* Effect.die(
        new Error(`Run '${runId}' does not exist. Create the run before activating it.`),
      );
    }

    const terminal = finished(stored);

    if (terminal) {
      if (stored.owner?.token === token) {
        yield* store.release(runId, token);
      }

      return terminal;
    }

    const run = yield* own(store, stored, token);
    const turn = { store, graph, runId, token, input: run.input };
    const queue = new Map<string, HostWork>();
    let cursor = options.cursor ?? null;

    const commit = (event: Parameters<typeof commitTurn>[1]) =>
      Effect.gen(function* () {
        const { disposition, work } = yield* commitTurn(turn, event);

        for (const effect of work) {
          queue.set(workId(effect), effect);
        }

        return disposition;
      });

    let disposition = yield* commit({ kind: "run_started", at });

    for (let count = 0; count < maxWork && disposition.kind !== "finished"; count++) {
      const ids = [...queue.keys()].sort();
      const id = ids.find((id) => cursor === null || id > cursor) ?? ids[0];
      const work = id === undefined ? undefined : queue.get(id);

      if (id === undefined || !work) {
        break;
      }

      queue.delete(id);
      cursor = id;

      const event = yield* reconcileDurableWork({ ...options, work });

      if (event) {
        disposition = yield* commit(event);
      }
    }

    const current = yield* store.getRun(runId);

    if (!current) {
      return yield* Effect.die(
        new Error("Run disappeared during activation. Restore its persisted state."),
      );
    }

    const outcome = finished(current);

    if (outcome || current.status === "suspended") {
      yield* store.release(runId, token);

      return (
        outcome ?? {
          status: "suspended" as const,
          nextWakeAt: current.status === "suspended" ? current.wakeAt : null,
          cursor: null,
        }
      );
    }

    const nextWakeAt = durableWakeAt({
      nodes: yield* store.getNodeRuns(runId),
      remaining: queue.values(),
      now: Date.parse(at),
      pollMs,
      leaseMs: store.leaseMs,
    });

    return { status: "pending", nextWakeAt, cursor } as const;
  });
}
