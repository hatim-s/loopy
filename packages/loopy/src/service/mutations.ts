import { Effect } from "effect";
import { isTerminalRun, type Json } from "../contract";
import type { RunRecord } from "../core";
import { type StoreEffect } from "../core";
import { requireDefinition } from "./definition";
import { ServiceError } from "./error";
import { validateDefinitionInput } from "./input";
import type { ServiceOptions } from "./registry";
import { makeRunAccess } from "./run-access";
import { makeRunViews } from "./run-views";

export function makeRunOperations(options: ServiceOptions) {
  const access = { ...makeRunAccess(options), ...makeRunViews(options) };

  const startRun = Effect.fn("mutations.startRun")(function* (
    slug: string,
    input: Json,
    workspace: string,
  ) {
    const saved = yield* requireDefinition(yield* options.registry(workspace), slug);
    const validated = yield* validateDefinitionInput(saved, input);

    const run: RunRecord = {
      id: crypto.randomUUID(),
      slug,
      input: validated,
      workspace: yield* options.canonicalWorkspace(workspace),
      revision: saved.revision,
      status: "queued",
      createdAt: new Date(options.clock.now()).toISOString(),
      updatedAt: new Date(options.clock.now()).toISOString(),
    };

    yield* options.store.createRun(run);

    return yield* access.view(run);
  });

  const now = () => {
    return new Date(options.clock.now()).toISOString();
  };

  const claim = Effect.fn("mutations.claim")(function* (id: string, token: string) {
    const run = yield* access.requireRun(id);

    if (isTerminalRun(run.status)) {
      return yield* Effect.fail(new ServiceError("not_claimable"));
    }

    yield* options.store.claim(id, token).pipe(
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
              const current = yield* options.store.getRun(id);

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
    const code = yield* options.store.wakeRun(id, now());

    if (code) {
      return yield* Effect.fail(new ServiceError(code));
    }

    return yield* access.view(yield* access.requireRun(id));
  });

  const cancellableNodes = Effect.fn("mutations.cancellableNodes")(function* (id: string) {
    const nodes = yield* options.store.getNodeRuns(id);

    if (nodes.some((node) => node.status === "running")) {
      return yield* Effect.fail(
        new ServiceError(
          "not_claimable",
          "This run has an unfinished execution. Resume it before cancelling.",
        ),
      );
    }

    if (nodes.length > 0) {
      const { graph } = yield* access.runGraph(id);

      if (graph.nodes.some((node) => node.kind === "finally")) {
        return yield* Effect.fail(
          new ServiceError(
            "not_claimable",
            "This run requires finally cleanup. Cancellation with cleanup is not available; resume the run instead.",
          ),
        );
      }
    }

    return nodes;
  });

  const cancelRun = Effect.fn("mutations.cancelRun")(function* (id: string) {
    const run = yield* access.requireRun(id);

    if (isTerminalRun(run.status)) {
      return yield* Effect.fail(new ServiceError("not_claimable"));
    }

    yield* cancellableNodes(id);
    const token = crypto.randomUUID();
    yield* Effect.acquireUseRelease(
      claim(id, token),
      () =>
        Effect.gen(function* () {
          const nodes = yield* cancellableNodes(id);
          const at = now();

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
          yield* options.store.apply({ runId: id, token, effects });
        }),
      () => options.store.release(id, token),
    );

    return yield* access.view(yield* access.requireRun(id));
  });

  const resolveNamedHook = Effect.fn("mutations.resolveNamedHook")(function* (
    id: string,
    name: string,
    payload: Json,
  ) {
    yield* access.requireRun(id);

    const waits = (yield* options.store.getWaits(id)).filter(
      (wait) => wait.name === name && !wait.resolvedAt && !wait.expiredAt,
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
    const result = yield* options.store.resolveWait({ token, payload, at: now() });

    if (result.kind === "rejected") {
      return yield* Effect.fail(new ServiceError(result.code, result.message));
    }

    return yield* access.view(yield* access.requireRun(result.runId));
  });

  return { startRun, resumeRun, cancelRun, resolveNamedHook, resolveHook };
}

export type RunOperations = ReturnType<typeof makeRunOperations>;
