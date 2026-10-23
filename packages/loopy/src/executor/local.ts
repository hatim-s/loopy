import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  durationMs,
  type ExecutionKey,
  type ExecutionMode,
  type ExecutionResult,
  type ExecutionSpec,
  type Executor,
} from "../core/index.js";
import { spawnCaptured } from "../local/execution-host.js";
import { FilesystemReceipts } from "./receipts.js";

type Options = {
  home: string;
  workspace: string;
  mode: ExecutionMode;
  secrets: readonly string[];
  bundlePath: (hash: string) => string;
  receipts?: FilesystemReceipts;
};

export class LocalExecutor implements Executor {
  private readonly receipts: FilesystemReceipts;

  constructor(private readonly options: Options) {
    this.receipts = options.receipts ?? new FilesystemReceipts(options.home);

    if (this.receipts.descriptor.home !== options.home) {
      throw new Error("Execution receipts must use the protected daemon home.");
    }
  }
  async lookup(key: ExecutionKey, attempt: number) {
    const identity = { executionKey: key, attempt };
    const receipt = await this.receipts.read(identity);

    if (!receipt) {
      return { kind: "none" as const };
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

      const latest = await this.receipts.read(identity);

      if (latest?.kind === "finished") {
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

      return this.receipts.finish({ kind: "finished", ...identity, result });
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
        env: this.options.mode === "full" ? process.env : { PATH: process.env.PATH },
        stdin: JSON.stringify({
          options: {
            home: this.options.home,
            workspace: this.options.workspace,
            mode: this.options.mode,
            secrets: this.options.secrets,
            receipts: this.receipts.descriptor,
            bundles,
          },
          key,
          attempt,
          spec,
        }),
      },
      {
        timeoutMs:
          spec.kind === "code"
            ? spec.timeoutMs + 30_000
            : (spec.node.options.timeout === undefined
                ? 300_000
                : durationMs(spec.node.options.timeout)) +
              (spec.parse === null ? 0 : 300_000) +
              30_000,
        maxOutputBytes: 64 * 1024,
      },
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
