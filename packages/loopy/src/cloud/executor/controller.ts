import type {
  ExecutionKey,
  ExecutionObservation,
  RemoteExecutor,
  StartCommand,
  StartReceipt,
  WorkspaceGeneration,
} from "../../runtime/remote-executor.js";

export type ExecutionReceipt = {
  key: ExecutionKey;
  revision: number;
  fingerprint?: string;
  workspace?: WorkspaceGeneration;
  deadline?: string;
  maxOutputBytes?: number;
  cancelRequested: boolean;
  observation: StartReceipt;
};

/** Implementations must atomically compare revision, including absence, within the full tenant key.
 * Receipts live outside the workload. They never contain command input or credentials.
 */
export interface ExecutionReceiptStore {
  read(key: ExecutionKey): Promise<ExecutionReceipt | undefined>;
  compareAndSwap(
    key: ExecutionKey,
    revision: number | undefined,
    next: ExecutionReceipt,
  ): Promise<boolean>;
}

/** A real adapter must enforce deadlines, output bounds, and process-group cleanup independently
 * of this controller's lifetime. Lookup must find the original stable key after a lost response.
 * Cancelled-before-start requires a durable tombstone that fences concurrent launch.
 * Control credentials and receipts must be inaccessible from the Linux workload.
 */
export interface LinuxExecutionProvider {
  workspace(workspace: WorkspaceGeneration): Promise<"available" | "lost">;
  start(request: StartCommand): Promise<StartReceipt>;
  inspect(key: ExecutionKey): Promise<ExecutionObservation>;
  cancel(key: ExecutionKey): Promise<ExecutionObservation>;
}

const unknown = (reason: string): StartReceipt => ({ state: "unknown", reason });
const terminal = (value: ExecutionObservation) =>
  value.state === "completed" || value.state === "cancelled-before-start";

export class RemoteLinuxExecutor implements RemoteExecutor {
  constructor(
    private readonly store: ExecutionReceiptStore,
    private readonly provider: LinuxExecutionProvider,
    private readonly now = () => Date.now(),
  ) {}

  async start(request: StartCommand): Promise<StartReceipt> {
    if (!request.fingerprint || !Number.isFinite(Date.parse(request.deadline)))
      throw new Error("Invalid execution identity or deadline");
    const limit = request.command.maxOutputBytes;
    if (limit === undefined || !Number.isSafeInteger(limit) || limit < 0)
      throw new Error("Remote commands require a bounded maxOutputBytes");
    for (;;) {
      const existing = await this.store.read(request.key);
      if (existing) {
        if (existing.fingerprint && existing.fingerprint !== request.fingerprint)
          throw new Error("Execution fingerprint conflict");
        return existing.observation;
      }
      const intent: ExecutionReceipt = {
        key: request.key,
        revision: 0,
        fingerprint: request.fingerprint,
        workspace: request.workspace,
        deadline: request.deadline,
        maxOutputBytes: limit,
        cancelRequested: false,
        observation: unknown("Start intent recorded; acknowledgement pending"),
      };
      if (!(await this.store.compareAndSwap(request.key, undefined, intent))) continue;
      try {
        if ((await this.provider.workspace(request.workspace)) === "lost")
          return await this.record(
            request.key,
            unknown("workspace-lost: expected generation unavailable"),
          );
        const latest = await this.store.read(request.key);
        if (latest?.cancelRequested || this.now() >= Date.parse(request.deadline)) {
          return await this.record(request.key, { state: "cancelled-before-start" });
        }
        const launched = await this.provider.start(request);
        await this.record(request.key, launched);
        if ((await this.store.read(request.key))?.cancelRequested) {
          const cancelled = await this.cancel(request.key);
          return cancelled.state === "not-started" ? unknown("Cancellation pending") : cancelled;
        }
        return (
          (await this.store.read(request.key))?.observation ??
          unknown("Execution receipt unavailable")
        );
      } catch {
        // The provider may have accepted the command. Only inspect can reconcile it.
        return (
          (await this.store.read(request.key))?.observation ??
          unknown("Execution receipt unavailable")
        );
      }
    }
  }

  async inspect(key: ExecutionKey): Promise<ExecutionObservation> {
    const receipt = await this.store.read(key);
    if (!receipt) return { state: "not-started" };
    if (terminal(receipt.observation)) return receipt.observation;
    try {
      if (receipt.workspace && (await this.provider.workspace(receipt.workspace)) === "lost")
        return await this.record(key, unknown("workspace-lost: expected generation unavailable"));
      if (
        receipt.cancelRequested ||
        (receipt.deadline && this.now() >= Date.parse(receipt.deadline))
      )
        return await this.cancel(key);
      const observed = await this.provider.inspect(key);
      // Absence cannot prove that a pending start was never accepted.
      return await this.record(
        key,
        observed.state === "not-started"
          ? unknown("Provider has no receipt; execution may still have started")
          : observed,
      );
    } catch {
      return receipt.observation;
    }
  }

  async cancel(key: ExecutionKey): Promise<ExecutionObservation> {
    for (;;) {
      const current = await this.store.read(key);
      if (current && terminal(current.observation)) return current.observation;
      const next: ExecutionReceipt = current
        ? { ...current, revision: current.revision + 1, cancelRequested: true }
        : {
            key,
            revision: 0,
            cancelRequested: true,
            observation: { state: "cancelled-before-start" },
          };
      if (!(await this.store.compareAndSwap(key, current?.revision, next))) continue;
      if (!current) return next.observation;
      try {
        const result = await this.provider.cancel(key);
        // A concurrent launch can follow an absent lookup. Require the provider's durable cancellation tombstone.
        return await this.record(
          key,
          result.state === "not-started"
            ? unknown("Cancellation pending; provider did not prove launch prevention")
            : result,
        );
      } catch {
        return next.observation;
      }
    }
  }

  private async record(key: ExecutionKey, observation: StartReceipt): Promise<StartReceipt> {
    for (;;) {
      const current = await this.store.read(key);
      if (!current) throw new Error("Execution receipt disappeared");
      if (terminal(current.observation)) return current.observation;
      let accepted = observation;
      if (
        (observation.state === "running" || observation.state === "completed") &&
        current.workspace &&
        (observation.workspace.workspaceId !== current.workspace.workspaceId ||
          observation.workspace.generation !== current.workspace.generation)
      ) {
        accepted = unknown("workspace-lost: provider returned a different generation");
      }
      if (
        observation.state === "completed" &&
        new TextEncoder().encode(observation.output.stdout + observation.output.stderr).byteLength >
          (current.maxOutputBytes ?? 0)
      ) {
        accepted = unknown("Provider exceeded output limit; result rejected");
      }
      if (
        await this.store.compareAndSwap(key, current.revision, {
          ...current,
          revision: current.revision + 1,
          observation: accepted,
        })
      )
        return accepted;
    }
  }
}
