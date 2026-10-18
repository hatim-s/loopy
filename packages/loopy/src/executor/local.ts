import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExecutionKey,
  type ExecutionMode,
  type ExecutionResult,
  type ExecutionSpec,
  type Executor,
  executionKeyString,
} from "../core/index.js";
import { spawnCaptured } from "../local/execution-host.js";
import { finishReceipt, lookupFile, receiptPath } from "./receipts.js";

type Options = {
  home: string;
  workspace: string;
  mode: ExecutionMode;
  secrets: readonly string[];
  bundlePath: (hash: string) => string;
};

export class LocalExecutor implements Executor {
  constructor(private readonly options: Options) {}
  async lookup(key: ExecutionKey, attempt: number) {
    const path = await receiptPath(this.options.workspace, key, attempt);
    const receipt = await lookupFile(path);

    if (
      receipt.kind !== "none" &&
      (executionKeyString(receipt.executionKey) !== executionKeyString(key) ||
        receipt.attempt !== attempt)
    ) {
      throw new Error("Receipt identity does not match this execution attempt.");
    }

    if (receipt.kind !== "started") {
      return receipt;
    }

    try {
      process.kill(receipt.pid, 0);

      return { kind: "started" as const };
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) {
        throw cause;
      }

      const latest = await lookupFile(path);

      if (latest.kind === "finished") {
        return latest;
      }

      const result: ExecutionResult = {
        kind: "failed",
        error: {
          code: "uncertain",
          message:
            "Executor stopped with an unfinished receipt. Inspect the workspace before starting a new run.",
        },
        exitCode: null,
        logs: [],
      };

      await finishReceipt(path, { kind: "finished", executionKey: key, attempt, result });

      return { kind: "finished" as const, result };
    }
  }
  async execute(
    key: ExecutionKey,
    attempt: number,
    spec: ExecutionSpec,
    signal: AbortSignal,
  ): Promise<ExecutionResult> {
    const previous = await this.lookup(key, attempt);

    if (previous.kind === "finished") {
      return previous.result;
    }

    if (previous.kind === "started") {
      throw new Error("Execution already started. Reconcile its receipt.");
    }

    const hashes =
      spec.kind === "code" ? [spec.bundleHash] : spec.parse ? [spec.parse.bundleHash] : [];

    const bundles = Object.fromEntries(hashes.map((hash) => [hash, this.options.bundlePath(hash)]));

    const worker = fileURLToPath(
      new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js", import.meta.url),
    );

    const output = await spawnCaptured(
      {
        program: process.execPath,
        args: ["--no-env-file", worker],
        cwd: dirname(worker),
        env: { PATH: process.env.PATH },
        stdin: JSON.stringify({ options: { ...this.options, bundles }, key, attempt, spec }),
      },
      { timeoutMs: 24 * 60 * 60_000, maxOutputBytes: 64 * 1024 },
      signal,
      performance.now(),
    );

    const receipt = await this.lookup(key, attempt);

    if (receipt.kind !== "finished") {
      return {
        kind: "failed",
        error: {
          code: "protocol",
          message: `Executor exited without a completion receipt. ${output.stderr.slice(-500)}`,
        },
        exitCode: output.exitCode,
        logs: [],
      };
    }

    return receipt.result;
  }
}
