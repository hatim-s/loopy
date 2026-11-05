import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Result, Schema } from "effect";
import {
  decodeBoundary,
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxAttemptRequest,
  type SandboxExecutionResult,
  sandboxExecutionResultSchema,
} from "../../../packages/loopy/src/contract/index.js";
import { CommandExecutionError } from "../../../packages/loopy/src/core/index.js";
import type { SandboxConfig } from "./config.js";
import { DockerClient } from "./docker-client.js";
import { attemptContainerArgs, inputContainerArgs } from "./docker-plan.js";
import type { SandboxOperationError } from "./operations.js";
import { checked, failure, io } from "./operations.js";
import { type CommandRunner, runCommand } from "./process.js";
import type { StartedReceipt } from "./receipts.js";
import { boundedResult, failed } from "./result.js";

const inspectionSchema = Schema.Array(
  Schema.Struct({
    Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
    State: Schema.Struct({
      Status: Schema.String,
      Running: Schema.Boolean,
      ExitCode: Schema.Finite,
      OOMKilled: Schema.Boolean,
    }),
  }),
).check(Schema.makeFilter((items) => items.length === 1));

export interface AttemptBackend {
  start(
    receipt: StartedReceipt,
    request: SandboxAttemptRequest,
    signal?: AbortSignal,
  ): Effect.Effect<SandboxExecutionResult, SandboxOperationError | CommandExecutionError>;
  recover(
    receipt: StartedReceipt,
    signal?: AbortSignal,
  ): Effect.Effect<SandboxExecutionResult, SandboxOperationError | CommandExecutionError>;
}

export class DockerBackend implements AttemptBackend {
  constructor(
    private readonly config: SandboxConfig,
    private readonly runner: CommandRunner = runCommand,
  ) {}

  private inspect(client: DockerClient, receipt: StartedReceipt) {
    return Effect.gen({ self: this }, function* () {
      const output = yield* client.call(["container", "inspect", receipt.container]);

      if (output.exitCode !== 0) {
        const listed = yield* client.required([
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${receipt.container}$`,
          "--format",
          "{{.Names}}",
        ]);

        if (!listed.stdout.trim()) {
          return null;
        }

        return yield* Effect.fail(
          failure("docker", new Error("Cannot inspect the owned attempt container.")),
        );
      }

      const container = (yield* checked("inspection", () =>
        Schema.decodeUnknownSync(inspectionSchema)(JSON.parse(output.stdout)),
      ))[0];

      if (
        !container ||
        container.Config.Labels["loopy.sandbox.owner"] !== client.owner ||
        container.Config.Labels["loopy.sandbox.request"] !== receipt.requestHash
      ) {
        return yield* Effect.fail(
          failure(
            "docker",
            new Error("Attempt container ownership does not match its durable receipt."),
          ),
        );
      }

      return container.State;
    });
  }

  start(receipt: StartedReceipt, request: SandboxAttemptRequest, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const client = new DockerClient(this.config, this.runner, signal);

      const early = yield* Effect.acquireUseRelease(
        io("staging directory", () => mkdtemp(join(this.config.stateRoot, "staging", "attempt-"))),
        (directory) =>
          Effect.gen({ self: this }, function* () {
            yield* io("staging", () =>
              writeFile(join(directory, "request.json"), JSON.stringify(request.spec), {
                mode: 0o444,
              }),
            ).pipe(Effect.uninterruptible);

            for (const bundle of request.bundles) {
              yield* io("staging", () =>
                writeFile(
                  join(directory, `${bundle.hash}.mjs`),
                  Buffer.from(bundle.bytes, "base64"),
                  { mode: 0o444 },
                ),
              ).pipe(Effect.uninterruptible);
            }

            // Docker cannot copy into a read-only root. A stopped helper fills a dedicated
            // volume, then the execution container mounts that input volume read-only.
            const helper = `${receipt.container}-input`;
            yield* client.required(inputContainerArgs(this.config, receipt, client.owner));
            yield* client.required(["cp", `${directory}/.`, `${helper}:/input/`]);
            yield* client.required(["rm", helper]);
            yield* client.required(attemptContainerArgs(this.config, receipt, client.owner));

            if (Date.now() >= receipt.deadline) {
              return failed("execution", "Attempt timed out before its container started.");
            }

            yield* client.required(["start", receipt.container]);
          }),
        (directory) =>
          Effect.gen({ self: this }, function* () {
            yield* io("docker", () => rm(directory, { recursive: true, force: true }));
          }),
      );

      if (early) {
        return early;
      }

      return yield* this.recover(receipt, signal);
    });
  }

  private waitForWorker(client: DockerClient, receipt: StartedReceipt) {
    return Effect.gen({ self: this }, function* () {
      const remaining = receipt.deadline - Date.now();

      const waited = yield* (
        remaining <= 0
          ? Effect.fail(
              new CommandExecutionError({
                reason: "timeout",
                message: "Process timed out.",
                output: { stdout: "", stderr: "", exitCode: -1, durationMs: 0 },
                cause: undefined,
              }),
            )
          : client.required(["wait", receipt.container], { timeoutMs: remaining, maxBytes: 1024 })
      ).pipe(Effect.result);

      if (Result.isFailure(waited)) {
        if (
          !(waited.failure instanceof CommandExecutionError && waited.failure.reason === "timeout")
        ) {
          return yield* Effect.fail(waited.failure);
        }

        const current = yield* this.inspect(client, receipt);

        if (current?.Running) {
          yield* client.required(["kill", receipt.container]);
        }

        const stopped = yield* this.inspect(client, receipt);

        if (stopped?.Running) {
          return yield* Effect.fail(
            failure("docker", new Error("Attempt container termination is not yet confirmed.")),
          );
        }

        return "timed_out" as const;
      }

      return "stopped" as const;
    });
  }

  recover(receipt: StartedReceipt, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const client = new DockerClient(this.config, this.runner, signal);
      const state = yield* this.inspect(client, receipt);

      if (state?.Status === "created") {
        // Removing a never-started container also fences a Docker start whose acknowledgement was lost.
        yield* client.required(["rm", "--force", receipt.container]);

        if ((yield* this.inspect(client, receipt)) !== null) {
          return yield* Effect.fail(
            failure("docker", new Error("Attempt container removal is not yet confirmed.")),
          );
        }
      }

      if (state === null || state.Status === "created") {
        return failed(
          "uncertain",
          "Attempt has a started receipt but no started worker. It will not be repeated.",
        );
      }

      if (state.Running && (yield* this.waitForWorker(client, receipt)) === "timed_out") {
        return failed("execution", "Attempt timed out. Its owned container was killed.");
      }

      const final = yield* this.inspect(client, receipt);

      if (final?.Running) {
        return yield* Effect.fail(
          failure("docker", new Error("Attempt worker remains running after Docker wait.")),
        );
      }

      if (!final || final.Status !== "exited" || final.ExitCode !== 0 || final.OOMKilled) {
        return failed(
          "uncertain",
          "Attempt worker disappeared or exited without a terminal result. It will not be repeated.",
        );
      }

      const terminal = yield* Effect.gen(function* () {
        const output = yield* client.required(["logs", receipt.container], {
          timeoutMs: 30_000,
          maxBytes: SANDBOX_MAX_CAPTURE_BYTES,
        });

        return yield* checked("worker result", () =>
          boundedResult(decodeBoundary(sandboxExecutionResultSchema)(JSON.parse(output.stdout))),
        );
      }).pipe(Effect.result);

      if (Result.isSuccess(terminal)) {
        return terminal.success;
      }

      const cause = terminal.failure;

      if (cause instanceof CommandExecutionError && cause.reason === "output_limit") {
        return failed("output_limit", "Attempt worker output exceeded its byte limit.");
      }

      return failed(
        "uncertain",
        "Attempt worker did not leave a valid terminal result. It will not be repeated.",
      );
    });
  }
}
