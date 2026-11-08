import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  artifactHelperName,
  decodeBoundary,
  type SandboxAttemptRequest,
  sandboxAttemptRequestSchema,
} from "@loopy/contract";
import { CommandExecutionError } from "@loopy/core";
import { Effect, Exit, Scope } from "effect";
import { z } from "zod";
import { attemptHash } from "../../../../apps/sandbox/src/admission";
import { DockerArtifacts } from "../../../../apps/sandbox/src/artifacts";
import { sandboxConfigSchema } from "../../../../apps/sandbox/src/config";
import { type AttemptBackend, DockerBackend } from "../../../../apps/sandbox/src/docker";
import { DockerClient } from "../../../../apps/sandbox/src/docker/client";
import { ownerOf, SANDBOX_LABELS } from "../../../../apps/sandbox/src/docker/identity";
import { inputHelperName } from "../../../../apps/sandbox/src/docker/plan";
import { SandboxOperationError } from "../../../../apps/sandbox/src/operations";
import { type CommandRunner, runCommand } from "../../../../apps/sandbox/src/process";
import { startSandbox } from "../../../../apps/sandbox/src/server";
import type { DockerAttemptPlan } from "../../../contract/src/sandbox-journal";
import { bounded, type DockerRuntime } from "./architecture-docker-runtime";

export const context = "colima-loopy-cloud-phase1";

const labelsSchema = z
  .array(
    z.object({
      Id: z.string(),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      State: z.object({
        Running: z.boolean(),
        Status: z.string(),
        StartedAt: z.string(),
        FinishedAt: z.string(),
      }),
    }),
  )
  .length(1);

export function input(runId: string, source: string, attempt = 1): SandboxAttemptRequest {
  const bytes = Buffer.from(source);
  const hash = createHash("sha256").update(bytes).digest("hex");

  return decodeBoundary(sandboxAttemptRequestSchema)({
    workspace: "proof",
    executionKey: { runId, nodeId: "0:code", scope: [] },
    attempt,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 60_000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
  });
}

export function resources(
  runtime: DockerRuntime,
  selectedImage: { image: string; imageId: string },
) {
  const { image, imageId } = selectedImage;

  const config = decodeBoundary(sandboxConfigSchema)({
    worktree: runtime.directory,
    stateRoot: runtime.stateRoot,
    token: "architecture-docker-synthetic-sandbox-0001",
    dockerContext: context,
    image,
    port: 0,
    maxTimeoutMs: 8000,
  });

  const owner = ownerOf(config.stateRoot);
  const plans = new Map<string, DockerAttemptPlan>();
  const starts = new Map<string, number>();
  const commands: object[] = [];
  let cleanupBlocked = false;

  const runner: CommandRunner = (argv, options) =>
    Effect.gen(function* () {
      assert.deepEqual(argv.slice(0, 3), ["docker", "--context", context]);

      if (
        cleanupBlocked &&
        argv[3] === "rm" &&
        argv[4] === "--force" &&
        argv[5]?.startsWith("loopy-artifact-")
      ) {
        runtime.record({ operation: "injected-helper-cleanup-failure", helper: argv[5] });

        return yield* Effect.fail(
          new CommandExecutionError({
            reason: "unstarted",
            output: { exitCode: 1, stdout: "", stderr: "", durationMs: 0 },
            message: "Injected helper cleanup outage before the actual Docker rm.",
            cause: null,
          }),
        );
      }

      const at = new Date().toISOString();
      const output = yield* runCommand(argv, options);
      commands.push({ at, argv, ...output });

      return output;
    });

  const docker = async (args: string[]) => {
    const output = await Effect.runPromise(
      runner(["docker", "--context", context, ...args], {
        cwd: config.worktree,
        timeoutMs: 10_000,
        maxBytes: 128 * 1024,
        env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
      }),
    );

    assert.equal(output.exitCode, 0, `Docker ${args[0]} failed: ${output.stderr}`);

    return output.stdout.trim();
  };

  const client = new DockerClient(config, runner);
  const backend = new DockerBackend(config, client);
  const reader = new DockerArtifacts(config, client);

  const recordIdentities = Effect.tryPromise({
    try: () =>
      writeFile(
        join(runtime.directory, "resource-identities.json"),
        JSON.stringify(
          {
            context,
            image,
            imageId,
            owner,
            plans: [...plans.values()],
            starts: [...starts],
            status: "active",
          },
          null,
          2,
        ),
      ),
    catch: (cause) =>
      new SandboxOperationError({
        operation: "fixture identities",
        cause,
        message: "Could not record resource identities.",
      }),
  });

  const countedBackend: AttemptBackend = {
    start: (receipt, request, signal) =>
      Effect.gen(function* () {
        plans.set(receipt.id, receipt);
        starts.set(receipt.id, (starts.get(receipt.id) ?? 0) + 1);
        runtime.record({ operation: "backend-start", receipt });
        assert.equal(
          starts.get(receipt.id),
          1,
          "An attempt must not issue a second backend start.",
        );
        yield* recordIdentities;

        return yield* backend.start(receipt, request, signal);
      }),
    recover: (receipt, signal) =>
      Effect.gen(function* () {
        plans.set(receipt.id, receipt);
        runtime.record({ operation: "backend-recover", receipt });
        yield* recordIdentities;

        return yield* backend.recover(receipt, signal);
      }),
  };

  function id(request: SandboxAttemptRequest) {
    return attemptHash({
      root: config.stateRoot,
      workspace: request.workspace,
      executionKey: request.executionKey,
      attempt: request.attempt,
    });
  }

  async function plan(request: SandboxAttemptRequest) {
    const record = await Effect.runPromise(runtime.direct.read(id(request)));
    assert(record, "Expected an authoritative durable attempt record.");
    plans.set(record.plan.id, record.plan);

    return record;
  }

  async function inspect(name: string) {
    const found = await docker([
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^/${name}$`,
      "--format",
      "{{.Names}}",
    ]);

    if (found === "") {
      return null;
    }

    assert.equal(found, name);
    const state = labelsSchema.parse(JSON.parse(await docker(["container", "inspect", name])))[0];
    assert(state);
    assert.equal(state.Config.Labels[SANDBOX_LABELS.owner], owner);

    return state;
  }

  const scopes = new Map<Effect.Success<ReturnType<typeof startSandbox>>, Scope.Closeable>();

  // Keep the same closing operation and scope until completion is observed, including after a timeout.
  const closingScopes = new Map<Scope.Closeable, Promise<void>>();

  async function closeScope(scope: Scope.Closeable) {
    let closing = closingScopes.get(scope);

    if (!closing) {
      closing = Effect.runPromise(Scope.close(scope, Exit.void));
      closingScopes.set(scope, closing);
    }

    await bounded(closing, "Fixture scope shutdown", 3000);
    closingScopes.delete(scope);
  }

  return {
    config,
    starts,
    docker,
    id,
    plan,
    inspect,
    blockCleanup() {
      cleanupBlocked = true;
    },
    healCleanup() {
      cleanupBlocked = false;
    },
    async preflight() {
      assert.equal(await docker(["image", "inspect", "--format", "{{.Id}}", image]), imageId);
      runtime.record({ operation: "image-pinned", context, image, imageId, owner });
    },
    async open() {
      const scope = Effect.runSync(Scope.make());

      try {
        const service = await Effect.runPromise(
          startSandbox(config, () =>
            Effect.succeed({
              authority: runtime.authority,
              resultsFor: (workspace) => runtime.authority.resultsFor(workspace),
              backend: countedBackend,
              artifactReader: reader,
            }),
          ).pipe(Effect.provideService(Scope.Scope, scope)),
        );

        scopes.set(service, scope);

        return service;
      } catch (cause) {
        try {
          await closeScope(scope);
        } catch (cleanup) {
          runtime.record({ operation: "scope-cleanup-unresolved", stateRoot: config.stateRoot });
          throw new AggregateError(
            [cause, cleanup],
            "Sandbox startup failed and scope cleanup is unresolved.",
          );
        }

        throw cause;
      }
    },
    async cleanup() {
      assert.equal(
        closingScopes.size,
        0,
        "Scope shutdown is unresolved. Retain owned resources and reconcile closure before cleanup.",
      );
      assert.equal(scopes.size, 0, "A bridge still owns its resources. Stop it before cleanup.");
      cleanupBlocked = false;
      const errors: unknown[] = [];

      for (const receipt of plans.values()) {
        for (const name of [
          receipt.container,
          inputHelperName(receipt),
          artifactHelperName(receipt.id),
        ]) {
          try {
            const state = await inspect(name);

            if (state) {
              assert.equal(state.Config.Labels[SANDBOX_LABELS.request], receipt.requestHash);

              if (name === artifactHelperName(receipt.id)) {
                assert.equal(state.Config.Labels[SANDBOX_LABELS.role], "artifact");
              }

              await docker(["rm", "--force", name]);
            }

            assert.equal(await inspect(name), null);
          } catch (cause) {
            errors.push(cause);
          }
        }
      }

      for (const volume of new Set([...plans.values()].flatMap((p) => [p.volume, p.inputVolume]))) {
        try {
          const exists = await docker([
            "volume",
            "ls",
            "--filter",
            `name=^${volume}$`,
            "--format",
            "{{.Name}}",
          ]);

          if (exists !== "") {
            assert.equal(exists, volume);

            const attached = await docker([
              "container",
              "ls",
              "--all",
              "--filter",
              `volume=${volume}`,
              "--format",
              "{{.Names}}",
            ]);

            assert.equal(attached, "", "Refuse volume cleanup with an unexpected attachment.");
            await docker(["volume", "rm", volume]);
          }

          assert.equal(
            await docker(["volume", "ls", "--filter", `name=^${volume}$`, "--format", "{{.Name}}"]),
            "",
          );
        } catch (cause) {
          errors.push(cause);
        }
      }

      await writeFile(
        join(runtime.directory, "docker-commands.json"),
        JSON.stringify(commands, null, 2),
      );
      await writeFile(
        join(runtime.directory, "resource-identities.json"),
        JSON.stringify(
          {
            context,
            image,
            imageId,
            owner,
            plans: [...plans.values()],
            starts: [...starts],
            cleanupErrors: errors.map(String),
          },
          null,
          2,
        ),
      );
      assert.equal(errors.length, 0, errors.map(String).join("\n"));
    },
    async stop(service: Effect.Success<ReturnType<typeof startSandbox>>) {
      const errors: unknown[] = [];

      try {
        await bounded(Effect.runPromise(service.close()), "Bridge shutdown", 3000);
      } catch (cause) {
        errors.push(cause);

        try {
          await bounded(
            Effect.runPromise(service.attempts.close()),
            "Emergency attempts shutdown",
            10_000,
          );
          await bounded(
            Promise.resolve(service.server.stop(true)),
            "Emergency HTTP shutdown",
            3000,
          );
        } catch (cleanup) {
          errors.push(cleanup);
        }
      }

      const scope = scopes.get(service);

      if (scope) {
        try {
          await closeScope(scope);
          scopes.delete(service);
        } catch (cleanup) {
          errors.push(cleanup);
          runtime.record({ operation: "scope-cleanup-unresolved", stateRoot: config.stateRoot });
        }
      }

      if (errors.length === 1) {
        throw errors[0];
      }

      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Bridge shutdown failed and cleanup has unresolved outcomes.",
        );
      }
    },
  };
}

export type DockerResources = ReturnType<typeof resources>;

export type Bridge = Awaited<ReturnType<DockerResources["open"]>>;
