import { appendFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AttemptBackend } from "../../apps/sandbox/src/docker.js";
import { state } from "./config.js";

export class RuntimeLimit {
  private active = 0;
  private readonly pending: {
    resume: () => void;
    reject: (cause: unknown) => void;
    signal?: AbortSignal;
    aborted: () => void;
  }[] = [];

  constructor(private readonly capacity: number) {}

  private acquire(signal?: AbortSignal) {
    signal?.throwIfAborted();

    if (this.active < this.capacity) {
      this.active += 1;

      return Promise.resolve();
    }

    return new Promise<void>((resume, reject) => {
      const entry = {
        resume,
        reject,
        signal,
        aborted: () => {
          const index = this.pending.indexOf(entry);

          if (index >= 0) {
            this.pending.splice(index, 1);
          }

          reject(new Error("Queued playground execution was aborted."));
        },
      };

      this.pending.push(entry);
      signal?.addEventListener("abort", entry.aborted, { once: true });
    });
  }

  async run<T>(operation: () => Promise<T>, signal?: AbortSignal) {
    await this.acquire(signal);

    try {
      signal?.throwIfAborted();

      return await operation();
    } finally {
      const next = this.pending.shift();

      if (next) {
        next.signal?.removeEventListener("abort", next.aborted);
        next.resume();
      } else {
        this.active -= 1;
      }
    }
  }
}

export function boundedBackend(backend: AttemptBackend, capacity: number): AttemptBackend {
  const limit = new RuntimeLimit(capacity);

  const guarded: AttemptBackend = {
    async start(receipt, request, signal) {
      const queuedAt = Date.now();

      return limit.run(async () => {
        const acquiredAt = Date.now();
        let outcome = "expired-in-queue";

        try {
          if (Date.now() >= receipt.deadline) {
            return {
              kind: "failed",
              error: {
                code: "execution",
                message: "Attempt deadline elapsed in playground backend queue.",
              },
              exitCode: null,
              logs: [],
            };
          }

          try {
            const result = await backend.start(receipt, request, signal);
            outcome = result.kind === "failed" ? result.error.code : "succeeded";

            if (result.kind === "failed" && result.error.code === "uncertain") {
              await writeFile(
                resolve(state, "ABORT"),
                "Provider returned an uncertain execution. Reconcile containers and receipts before resuming.\n",
              );
            }

            return result;
          } catch (cause) {
            outcome = "transport-exception";
            await writeFile(
              resolve(state, "ABORT"),
              "Docker backend threw. Stop new admissions and reconcile owned containers.\n",
            );
            throw cause;
          }
        } finally {
          const finishedAt = Date.now();
          await appendFile(
            resolve(state, "runtime-queue.jsonl"),
            `${JSON.stringify({ executionKey: receipt.executionKey, attempt: receipt.attempt, queuedAt: new Date(queuedAt).toISOString(), acquiredAt: new Date(acquiredAt).toISOString(), finishedAt: new Date(finishedAt).toISOString(), queueWaitMs: acquiredAt - queuedAt, backendDurationMs: finishedAt - acquiredAt, outcome })}\n`,
            { mode: 0o600 },
          );
        }
      }, signal);
    },
    recover: (receipt, signal) => limit.run(() => backend.recover(receipt, signal), signal),
  };

  return guarded;
}
