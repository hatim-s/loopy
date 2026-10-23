import { isTerminalRun, type Json, type RunView } from "../contract/index.js";
import { OwnershipError, type StoreEffect } from "../core/index.js";
import { ServiceError } from "./error.js";
import type { ServiceOptions } from "./registry.js";
import type { LoopyService } from "./service.js";

export class ServiceMutations {
  constructor(
    private readonly options: ServiceOptions,
    private readonly access: Pick<LoopyService, "requireRun" | "runGraph" | "view">,
  ) {}

  private now() {
    return new Date(this.options.clock.now()).toISOString();
  }

  private async claim(id: string, token: string) {
    const run = await this.access.requireRun(id);

    if (isTerminalRun(run.status)) {
      throw new ServiceError("not_claimable");
    }

    try {
      await this.options.store.claim(id, token);
    } catch (error) {
      if (error instanceof OwnershipError) {
        throw new ServiceError(
          "owned_elsewhere",
          `Run '${id}' is owned by PID ${run.owner?.pid} on ${run.owner?.host}. Stop its runner before retrying.`,
        );
      }

      // Completion can win the race after requireRun but before the store claims ownership.
      const current = await this.options.store.getRun(id);

      if (current && isTerminalRun(current.status)) {
        throw new ServiceError("not_claimable");
      }

      throw error;
    }
  }

  async resumeRun(id: string): Promise<RunView> {
    const code = await this.options.store.wakeRun(id, this.now());

    if (code) {
      throw new ServiceError(code);
    }

    return this.access.view(await this.access.requireRun(id));
  }

  private async cancellableNodes(id: string) {
    const nodes = await this.options.store.getNodeRuns(id);

    if (nodes.some((node) => node.status === "running")) {
      throw new ServiceError(
        "not_claimable",
        "This run has an unfinished execution. Resume it before cancelling.",
      );
    }

    if (nodes.length > 0) {
      const { graph } = await this.access.runGraph(id);

      if (graph.nodes.some((node) => node.kind === "finally")) {
        throw new ServiceError(
          "not_claimable",
          "This run requires finally cleanup. Cancellation with cleanup is not available; resume the run instead.",
        );
      }
    }

    return nodes;
  }

  async cancelRun(id: string): Promise<RunView> {
    const run = await this.access.requireRun(id);

    if (isTerminalRun(run.status)) {
      throw new ServiceError("not_claimable");
    }

    await this.cancellableNodes(id);
    const token = crypto.randomUUID();
    await this.claim(id, token);

    try {
      const nodes = await this.cancellableNodes(id);

      const at = this.now();

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
      await this.options.store.apply({ runId: id, token, effects });
    } finally {
      await this.options.store.release(id, token);
    }

    return this.access.view(await this.access.requireRun(id));
  }

  async resolveNamedHook(id: string, name: string, payload: Json): Promise<RunView> {
    await this.access.requireRun(id);

    const waits = (await this.options.store.getWaits(id)).filter(
      (wait) => wait.name === name && !wait.resolvedAt && !wait.expiredAt,
    );

    if (waits.length > 1) {
      throw new ServiceError(
        "bad_request",
        "More than one pending wait has this name. Resolve a specific hook token.",
      );
    }

    const wait = waits[0];

    if (!wait) {
      throw new ServiceError("unknown_hook");
    }

    return this.resolveHook(wait.token, payload);
  }

  async resolveHook(token: string, payload: Json): Promise<RunView> {
    const result = await this.options.store.resolveWait({ token, payload, at: this.now() });

    if (result.kind === "rejected") {
      throw new ServiceError(result.code, result.message);
    }

    return this.access.view(await this.access.requireRun(result.runId));
  }
}
