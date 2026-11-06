import {
  type ExecutionKey,
  type ExecutionSpec,
  type Graph,
  OwnershipError,
  type Receipt,
  type RunOutcome,
  type RunRecord,
  requirePositiveInteger,
  type Store,
} from "@loopy/core";
import { type EngineEvent, initialState, step } from "@loopy/core/engine";
import { Data, Effect } from "effect";
import { planActivation } from "../activation/plan";
import { durableWakeAt } from "./wake";
import { type DurableWork, durableWorkId, reconcileDurableWork } from "./work";

export class DurableProviderError extends Data.TaggedError("DurableProviderError")<{
  operation: "lookup" | "start";
  reason: "transport" | "protocol";
  message: string;
  cause: unknown;
}> {}

/** Receipts are durable and keyed by the complete execution key and attempt.
 * start atomically deduplicates that identity and returns promptly, without waiting
 * for execution. lookup reports started while work lives, or a finished uncertain
 * result if its worker disappears. A transport failure fails with DurableProviderError instead of returning none.
 */
export interface DurableExecutionProvider {
  lookup(key: ExecutionKey, attempt: number): Effect.Effect<Receipt, DurableProviderError>;
  start(
    key: ExecutionKey,
    attempt: number,
    spec: ExecutionSpec,
  ): Effect.Effect<Receipt, DurableProviderError>;
}

export type DurableActivationOptions = {
  store: Store;
  graph: Graph;
  runId: string;
  provider: DurableExecutionProvider;
  /** Unique to the owning scheduler session. Keep it across turns, replace it on reconstruction. */
  token: string;
  at: string;
  /** Maximum dispatch/receipt checks and samples. Each can commit one completion transition. */
  maxWork?: number;
  pollMs?: number;
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
      outcome = { status: "succeeded", output: run.output ?? null };
      break;
    case "failed":
      outcome = { status: "failed", error: run.error ?? "Run failed." };
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
    const { store, graph, runId, token, at } = options;
    const maxWork = requirePositiveInteger(options.maxWork ?? 32, "maxWork");
    const pollMs = requirePositiveInteger(options.pollMs ?? 1000, "pollMs");
    const now = Date.parse(at);

    if (!Number.isFinite(now)) {
      return yield* Effect.die(new Error("Activation time is invalid. Supply an ISO timestamp."));
    }

    let run = yield* store.getRun(runId);

    if (!run) {
      return yield* Effect.die(
        new Error(`Run '${runId}' does not exist. Create the run before activating it.`),
      );
    }

    const terminal = finished(run);

    if (terminal) {
      if (run.owner?.token === token) {
        yield* store.release(runId, token);
      }

      return terminal;
    }

    run = yield* own(store, run, token);

    const queue = new Map<string, DurableWork>();
    let cursor = options.cursor ?? null;
    const input = run.input;

    const commit = (event: EngineEvent) =>
      Effect.gen(function* () {
        const state = initialState(runId, input, yield* store.getNodeRuns(runId));
        const transition = step(graph, state, event);

        const plan = planActivation(transition);

        // Persist the whole transition before any provider work, even beyond this turn's budget.
        yield* store.apply({ runId, token, effects: plan.storeEffects });

        for (const effect of plan.work) {
          if (effect.kind !== "schedule_retry") {
            queue.set(durableWorkId(effect), effect);
          }
        }

        return plan.disposition;
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

      const event = yield* reconcileDurableWork({
        ...options,
        work,
      });

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
          nextWakeAt: current.wakeAt ?? null,
          cursor: null,
        }
      );
    }

    const nextWakeAt = durableWakeAt({
      nodes: yield* store.getNodeRuns(runId),
      remaining: queue.values(),
      now,
      pollMs,
      leaseMs: store.leaseMs,
    });

    return { status: "pending", nextWakeAt, cursor } as const;
  });
}
