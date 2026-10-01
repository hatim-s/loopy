import type { RunRecord } from "../core/model.js";
import { RunBusyError } from "../runtime/errors.js";
import type { Runtime } from "../runtime/runtime.js";

export type CloudWorkMessage = { runId: string };

export type CloudWorkOutcome =
  | { disposition: "ack"; run: RunRecord }
  | { disposition: "retry"; reason: "busy" | "cancelled"; runId: string };

type WorkerRuntime = Pick<Runtime, "getRun" | "execute">;

function parseMessage(value: unknown): CloudWorkMessage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Cloud work message must be an object");
  const message = value as Record<string, unknown>;
  if (
    typeof message.runId !== "string" ||
    message.runId.trim().length === 0 ||
    Object.keys(message).some((key) => key !== "runId")
  )
    throw new Error("Invalid cloud work message");
  return { runId: message.runId };
}

/**
 * Executes a persisted run delivered by a host queue. The host acknowledges `ack`,
 * retries `busy` or `cancelled`, and retries thrown infrastructure errors. It must dead-letter
 * malformed or unknown messages according to its own queue policy. Queue
 * deliveries start or continue initial execution. A host must authorize terminal resumes separately.
 */
export class CloudWorker {
  constructor(private readonly runtime: WorkerRuntime) {}

  async handle(
    message: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<CloudWorkOutcome> {
    const { runId } = parseMessage(message);
    const run = await this.runtime.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    if (run.options.workspace.kind !== "managed")
      throw new Error(`Run ${runId} uses a local workspace`);
    if (options.signal?.aborted && (run.status === "pending" || run.status === "running"))
      return { disposition: "retry", reason: "cancelled", runId };

    try {
      const result = await this.runtime.execute(runId, {
        resume: false,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (result.status === "pending") return { disposition: "retry", reason: "cancelled", runId };
      if (result.status === "running") throw new Error(`Run ${runId} did not settle`);
      return { disposition: "ack", run: result };
    } catch (error) {
      if (error instanceof RunBusyError) return { disposition: "retry", reason: "busy", runId };
      throw error;
    }
  }
}
