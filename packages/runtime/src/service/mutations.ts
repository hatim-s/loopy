import { cancelRefusal, isTerminalRun, type Json } from "@loopy/contract";
import {
  executionKeyString,
  isPendingWait,
  type RunRecord,
  type StoreEffect,
  withLease,
} from "@loopy/core";
import { Effect } from "effect";
import type { ServiceContext } from "./context";
import { requireDefinition } from "./definition";
import { ServiceError } from "./error";
import { validateDefinitionInput } from "./input";
import type { RunViews } from "./run-views";

export function makeRunOperations(context: ServiceContext, { view }: RunViews) {
  const { store, now, requireRun } = context;

  const startRun = Effect.fn("mutations.startRun")(function* (
    slug: string,
    input: Json,
    workspace: string,
  ) {
    const saved = yield* requireDefinition(yield* context.registry(workspace), slug);
    const validated = yield* validateDefinitionInput(saved, input);

    const createdAt = yield* now;

    const run: RunRecord = {
      id: crypto.randomUUID(),
      slug,
      input: validated,
      workspace: yield* context.canonicalWorkspace(workspace),
      revision: saved.revision,
      status: "queued",
      createdAt,
      updatedAt: createdAt,
    };

    yield* store.createRun(run);

    return yield* view(run);
  });

  const claim = Effect.fn("mutations.claim")(function* (id: string, token: string) {
    const run = yield* requireRun(id);

    if (isTerminalRun(run.status)) {
      return yield* Effect.fail(new ServiceError("not_claimable"));
    }

    return yield* store.claim(id, token).pipe(
      Effect.catchTag("OwnershipError", () =>
        Effect.fail(
          new ServiceError(
            "owned_elsewhere",
            `Run '${id}' is owned by PID ${run.owner?.pid} on ${run.owner?.host}. Stop its runner before retrying.`,
          ),
        ),
      ),
      Effect.catchTag("StorageError", (error) =>
        error.reason === "rejected"
          ? Effect.gen(function* () {
              const current = yield* store.getRun(id);

              if (current && isTerminalRun(current.status)) {
                return yield* Effect.fail(new ServiceError("not_claimable"));
              }

              return yield* Effect.fail(error);
            })
          : Effect.fail(error),
      ),
    );
  });

  const resumeRun = Effect.fn("mutations.resumeRun")(function* (id: string) {
    const code = yield* store.wakeRun(id, yield* now);

    if (code) {
      return yield* Effect.fail(new ServiceError(code));
    }

    return yield* view(yield* requireRun(id));
  });

  const cancellableNodes = Effect.fn("mutations.cancellableNodes")(function* (id: string) {
    const nodes = yield* store.getNodeRuns(id);

    // The graph is read only when node state alone cannot refuse.
    const refusal =
      cancelRefusal(nodes, { nodes: [] }) ??
      (nodes.length > 0 ? cancelRefusal(nodes, (yield* context.runGraph(id)).graph) : null);

    if (refusal !== null) {
      return yield* Effect.fail(new ServiceError("not_claimable", refusal));
    }

    return nodes;
  });

  const cancelRun = Effect.fn("mutations.cancelRun")(function* (id: string) {
    const run = yield* requireRun(id);

    if (isTerminalRun(run.status)) {
      return yield* Effect.fail(new ServiceError("not_claimable"));
    }

    yield* cancellableNodes(id);
    yield* withLease(
      { claim, release: (runId, token) => store.release(runId, token) },
      id,
      (token) =>
        Effect.gen(function* () {
          const nodes = yield* cancellableNodes(id);
          const at = yield* now;

          const effects: StoreEffect[] = nodes.flatMap((node) =>
            node.status === "waiting" ||
            node.status === "sleeping" ||
            node.status === "retrying" ||
            node.status === "rate_limited" ||
            node.status === "queued"
              ? [
                  {
                    kind: "write_node_run" as const,
                    nodeRun: {
                      key: node.key,
                      attempt: node.attempt,
                      maxAttempts: node.maxAttempts,
                      startedAt: node.startedAt,
                      receipt: node.receipt,
                      status: "cancelled" as const,
                      endedAt: at,
                    },
                  },
                ]
              : [],
          );

          effects.push({ kind: "finish_run", outcome: { status: "cancelled" }, at });
          yield* store.apply({ runId: id, token, effects });
        }),
    );

    return yield* view(yield* requireRun(id));
  });

  const resolveNamedHook = Effect.fn("mutations.resolveNamedHook")(function* (
    id: string,
    name: string,
    payload: Json,
  ) {
    const run = yield* requireRun(id);
    const at = yield* now;
    const named = (yield* store.getWaits(id)).filter((wait) => wait.name === name);

    const nodes = new Map(
      (named.length === 0 ? [] : yield* store.getNodeRuns(id)).map((node) => [
        executionKeyString(node.key),
        node,
      ]),
    );

    const waits = named.filter((wait) =>
      isPendingWait({ wait, node: nodes.get(executionKeyString(wait.executionKey)), run, at }),
    );

    if (waits.length > 1) {
      return yield* Effect.fail(
        new ServiceError(
          "bad_request",
          "More than one pending wait has this name. Resolve a specific hook token.",
        ),
      );
    }

    const wait = waits[0];

    if (!wait) {
      return yield* Effect.fail(new ServiceError("unknown_hook"));
    }

    return yield* resolveHook(wait.token, payload);
  });

  const resolveHook = Effect.fn("mutations.resolveHook")(function* (token: string, payload: Json) {
    const result = yield* store.resolveWait({ token, payload, at: yield* now });

    if (result.kind === "rejected") {
      return yield* Effect.fail(new ServiceError(result.code, result.message));
    }

    return yield* view(yield* requireRun(result.runId));
  });

  return { startRun, resumeRun, cancelRun, resolveNamedHook, resolveHook };
}

export type RunOperations = ReturnType<typeof makeRunOperations>;
