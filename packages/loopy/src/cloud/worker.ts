import { allowKeys, type RunRecord, requireNonEmptyString, requireRecord } from "../core/index.js";
import { RunBusyError, type Runtime } from "../runtime/index.js";

export type CloudWorkMessage = { runId: string };

export type CloudWorkOutcome =
  | { disposition: "ack"; run: RunRecord }
  | { disposition: "retry"; reason: "busy" | "cancelled"; runId: string };

type WorkerRuntime = Pick<Runtime, "getRun" | "execute">;

// BOUNDARY: Host queue payloads must contain only a nonempty runId before the worker loads durable state.
function parseMessage(value: unknown): CloudWorkMessage {
  const message = requireRecord(value, "Cloud work message");
  allowKeys(message, "Cloud work message", ["runId"]);

  return { runId: requireNonEmptyString(message.runId, "Cloud work message.runId") };
}

/**
 * Executes a persisted run delivered by a host queue. The host acknowledges `ack`,
 * retries `busy` or `cancelled`, and retries thrown infrastructure errors. It must dead-letter
 * malformed or unknown messages according to its own queue policy. Queue
 * deliveries start or continue initial execution. A host must authorize terminal resumes separately.
 */
export class CloudWorker {
  constructor(private readonly runtime: WorkerRuntime) {}

  // BOUNDARY: Host queue messages are parsed for runId, then the loaded run is checked for a managed workspace.
  async handle(
    message: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudWorkOutcome> {
    const { runId } = parseMessage(message);
    const run = await this.runtime.getRun(runId);

    if (!run) {
      throw new Error(`Unknown run ${runId}.`);
    }

    if (run.options.workspace.kind !== "managed") {
      throw new Error(`Run ${runId} uses a local workspace, which a cloud worker cannot execute.`);
    }

    if (options.signal?.aborted && (run.status === "pending" || run.status === "running")) {
      return { disposition: "retry", reason: "cancelled", runId };
    }

    try {
      const execution: Parameters<Runtime["execute"]>[1] = { resume: false };

      if (options.signal) {
        execution.signal = options.signal;
      }

      const result = await this.runtime.execute(runId, execution);

      if (result.status === "pending") {
        return { disposition: "retry", reason: "cancelled", runId };
      }

      if (result.status === "running") {
        throw new Error(`Run ${runId} did not settle.`);
      }

      return { disposition: "ack", run: result };
    } catch (error) {
      if (error instanceof RunBusyError) {
        return { disposition: "retry", reason: "busy", runId };
      }

      throw error;
    }
  }
}
