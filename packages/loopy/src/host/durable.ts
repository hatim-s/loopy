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
  type StoreEffect,
} from "../core/index.js";
import { type EngineEvent, initialState, step } from "../engine/index.js";
import { durableWakeAt } from "./durable-wake.js";
import { type DurableWork, durableWorkId, reconcileDurableWork } from "./durable-work.js";

/** Receipts are durable and keyed by the complete execution key and attempt.
 * start atomically deduplicates that identity and returns promptly, without waiting
 * for execution. lookup reports started while work lives, or a finished uncertain
 * result if its worker disappears. A transport failure throws instead of returning none.
 */
export interface DurableExecutionProvider {
  lookup(key: ExecutionKey, attempt: number): Promise<Receipt>;
  start(key: ExecutionKey, attempt: number, spec: ExecutionSpec): Promise<Receipt>;
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

async function own(store: Store, run: RunRecord, token: string): Promise<RunRecord> {
  if (run.owner?.token === token) {
    // Recover a turn interrupted between committing suspension and releasing ownership.
    if (run.status === "suspended") {
      await store.release(run.id, token);

      return store.claim(run.id, token);
    }

    if (!(await store.heartbeat(run.id, token))) {
      throw new OwnershipError(run.id);
    }

    return run;
  }

  return store.claim(run.id, token);
}

/** The caller serializes turns and hook mutations, coordinates SQL transactions,
 * and persists scheduler metadata with an alarm before starting the turn. Pending
 * work retains ownership and a concurrency slot. On errors retain both and resume
 * reconciliation. A new owner session must wait for the Store lease to become stale.
 * No transaction may span provider calls. Providers must bound their own request time.
 */
export async function activateDurable(
  options: DurableActivationOptions,
): Promise<DurableActivationResult> {
  const { store, graph, runId, token, at } = options;
  const maxWork = requirePositiveInteger(options.maxWork ?? 32, "maxWork");
  const pollMs = requirePositiveInteger(options.pollMs ?? 1000, "pollMs");
  const now = Date.parse(at);

  if (!Number.isFinite(now)) {
    throw new Error("Activation time is invalid. Supply an ISO timestamp.");
  }

  let run = await store.getRun(runId);

  if (!run) {
    throw new Error(`Run '${runId}' does not exist. Create the run before activating it.`);
  }

  const terminal = finished(run);

  if (terminal) {
    if (run.owner?.token === token) {
      await store.release(runId, token);
    }

    return terminal;
  }

  run = await own(store, run, token);

  const queue = new Map<string, DurableWork>();
  let cursor = options.cursor ?? null;
  const input = run.input;

  async function commit(event: EngineEvent) {
    const state = initialState(runId, input, await store.getNodeRuns(runId));
    const transition = step(graph, state, event);

    const retrying = transition.state.nodeRuns.some(
      (node) => node.status === "retrying" || node.status === "rate_limited",
    );

    // Commit the whole transition even when its dispatches exceed this turn's budget.
    // run_started recovers every unprocessed dispatch and sample on the next alarm.
    await store.apply({
      runId,
      token,
      effects: transition.effects.filter(
        (effect): effect is StoreEffect =>
          effect.kind !== "dispatch" &&
          effect.kind !== "sample" &&
          // A waiting sibling must not surrender a retry's concurrency slot.
          !(effect.kind === "suspend_run" && retrying),
      ),
    });

    for (const effect of transition.effects) {
      if (effect.kind === "dispatch" || effect.kind === "sample") {
        queue.set(durableWorkId(effect), effect);
      }
    }

    return transition;
  }

  let transition = await commit({ kind: "run_started", at });

  for (let count = 0; count < maxWork && transition.state.phase.kind !== "finished"; count++) {
    const ids = [...queue.keys()].sort();
    const id = ids.find((id) => cursor === null || id > cursor) ?? ids[0];
    const work = id === undefined ? undefined : queue.get(id);

    if (id === undefined || !work) {
      break;
    }

    queue.delete(id);
    cursor = id;

    const event = await reconcileDurableWork({
      ...options,
      work,
      state: initialState(runId, input, await store.getNodeRuns(runId)),
    });

    if (event) {
      transition = await commit(event);
    }
  }

  const current = await store.getRun(runId);

  if (!current) {
    throw new Error("Run disappeared during activation. Restore its persisted state.");
  }

  const outcome = finished(current);

  if (outcome || current.status === "suspended") {
    await store.release(runId, token);

    return outcome ?? { status: "suspended", nextWakeAt: current.wakeAt ?? null, cursor: null };
  }

  const nextWakeAt = durableWakeAt({
    nodes: await store.getNodeRuns(runId),
    remaining: queue.values(),
    now,
    pollMs,
    leaseMs: store.leaseMs,
  });

  return { status: "pending", nextWakeAt, cursor };
}
