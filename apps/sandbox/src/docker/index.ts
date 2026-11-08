import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type DockerAttemptPlan,
  decodeBoundary,
  type ExecutionResult,
  executionResultSchema,
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxAttemptRequest,
} from "@loopy/contract";
import { CommandExecutionError } from "@loopy/runtime/os";
import { Effect, Result, Schema } from "effect";
import type { SandboxConfig } from "../config";
import { bundleFile, CONTAINER } from "../container-layout";
import type { SandboxOperationError } from "../operations";
import { checked, failure, io } from "../operations";
import { failed } from "../result";
import { stateLayout } from "../state-root";
import type { DockerClient } from "./client";
import { attemptContainerArgs, inputContainerArgs, inputHelperName } from "./plan";

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
    plan: DockerAttemptPlan,
    request: SandboxAttemptRequest,
    signal?: AbortSignal,
  ): Effect.Effect<ExecutionResult, SandboxOperationError | CommandExecutionError>;
  recover(
    plan: DockerAttemptPlan,
    signal?: AbortSignal,
  ): Effect.Effect<ExecutionResult, SandboxOperationError | CommandExecutionError>;
}

export class DockerBackend implements AttemptBackend {
  constructor(
    private readonly config: SandboxConfig,
    private readonly docker: DockerClient,
  ) {}

  private inspect(plan: DockerAttemptPlan, signal: AbortSignal | undefined) {
    return Effect.gen({ self: this }, function* () {
      const output = yield* this.docker.call(["container", "inspect", plan.container], { signal });

      if (output.exitCode !== 0) {
        if (!(yield* this.docker.exists(plan.container, signal))) {
          return null;
        }

        return yield* Effect.fail(
          failure("docker", new Error("Cannot inspect the owned attempt container.")),
        );
      }

      const container = (yield* checked("inspection", () =>
        Schema.decodeUnknownSync(inspectionSchema)(JSON.parse(output.stdout)),
      ))[0];

      if (!container || !this.docker.owns(container.Config.Labels, plan.requestHash)) {
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

  start(plan: DockerAttemptPlan, request: SandboxAttemptRequest, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const docker = this.docker;
      const labels = docker.labels(plan.requestHash);

      const early = yield* Effect.acquireUseRelease(
        io("staging directory", () =>
          mkdtemp(join(stateLayout(this.config.stateRoot).staging, "attempt-")),
        ),
        (directory) =>
          Effect.gen({ self: this }, function* () {
            yield* io("staging", () =>
              writeFile(join(directory, CONTAINER.request), JSON.stringify(request.spec), {
                mode: 0o444,
              }),
            ).pipe(Effect.uninterruptible);

            for (const bundle of request.bundles) {
              yield* io("staging", () =>
                writeFile(
                  join(directory, bundleFile(bundle.hash)),
                  Buffer.from(bundle.bytes, "base64"),
                  {
                    mode: 0o444,
                  },
                ),
              ).pipe(Effect.uninterruptible);
            }

            // Docker cannot copy into a read-only root. A stopped helper fills a dedicated
            // volume, then the execution container mounts that input volume read-only.
            const helper = inputHelperName(plan);
            yield* docker.required(inputContainerArgs(this.config, plan, labels), { signal });
            yield* docker.required(["cp", `${directory}/.`, `${helper}:${CONTAINER.input}/`], {
              signal,
            });
            yield* docker.required(["rm", helper], { signal });
            yield* docker.required(attemptContainerArgs(this.config, plan, labels), { signal });

            if (Date.now() >= plan.deadline) {
              return failed("execution", "Attempt timed out before its container started.");
            }

            yield* docker.required(["start", plan.container], { signal });
          }),
        (directory) =>
          Effect.gen({ self: this }, function* () {
            yield* io("docker", () => rm(directory, { recursive: true, force: true }));
          }),
      );

      if (early) {
        return early;
      }

      return yield* this.recover(plan, signal);
    });
  }

  private waitForWorker(plan: DockerAttemptPlan, signal: AbortSignal | undefined) {
    return Effect.gen({ self: this }, function* () {
      const remaining = plan.deadline - Date.now();

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
          : this.docker.required(["wait", plan.container], {
              timeoutMs: remaining,
              maxBytes: 1024,
              signal,
            })
      ).pipe(Effect.result);

      if (Result.isFailure(waited)) {
        if (
          !(waited.failure instanceof CommandExecutionError && waited.failure.reason === "timeout")
        ) {
          return yield* Effect.fail(waited.failure);
        }

        const current = yield* this.inspect(plan, signal);

        if (current?.Running) {
          yield* this.docker.required(["kill", plan.container], { signal });
        }

        const stopped = yield* this.inspect(plan, signal);

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

  recover(plan: DockerAttemptPlan, signal?: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const docker = this.docker;
      const state = yield* this.inspect(plan, signal);

      if (state?.Status === "created") {
        // Removing a never-started container also fences a Docker start whose acknowledgement was lost.
        yield* docker.required(["rm", "--force", plan.container], { signal });

        if ((yield* this.inspect(plan, signal)) !== null) {
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

      if (state.Running && (yield* this.waitForWorker(plan, signal)) === "timed_out") {
        return failed("execution", "Attempt timed out. Its owned container was killed.");
      }

      const final = yield* this.inspect(plan, signal);

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
        const output = yield* docker.required(["logs", plan.container], {
          timeoutMs: 30_000,
          maxBytes: SANDBOX_MAX_CAPTURE_BYTES,
          signal,
        });

        return yield* checked("worker result", () =>
          decodeBoundary(executionResultSchema)(JSON.parse(output.stdout)),
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
