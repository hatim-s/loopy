import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { attemptHash } from "../../../../apps/sandbox/src/admission.js";
import { DockerArtifacts } from "../../../../apps/sandbox/src/artifacts.js";
import { sandboxConfigSchema } from "../../../../apps/sandbox/src/config.js";
import { type AttemptBackend, DockerBackend } from "../../../../apps/sandbox/src/docker.js";
import { type CommandRunner, runCommand } from "../../../../apps/sandbox/src/process.js";
import { startSandbox } from "../../../../apps/sandbox/src/server.js";
import {
  type SandboxAttemptRequest,
  sandboxAttemptRequestSchema,
} from "../../src/contract/index.js";
import type { DockerAttemptPlan } from "../../src/contract/sandbox-journal.js";
import { bounded, type DockerRuntime } from "./architecture-docker-runtime.js";

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

  return sandboxAttemptRequestSchema.parse({
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

  const config = sandboxConfigSchema.parse({
    worktree: runtime.directory,
    stateRoot: runtime.stateRoot,
    token: "architecture-docker-synthetic-sandbox-0001",
    dockerContext: context,
    image,
    port: 0,
    maxTimeoutMs: 8000,
  });

  const owner = createHash("sha256").update(config.stateRoot).digest("hex");
  const plans = new Map<string, DockerAttemptPlan>();
  const starts = new Map<string, number>();
  const commands: object[] = [];
  let cleanupBlocked = false;

  const runner: CommandRunner = async (argv, options) => {
    assert.deepEqual(argv.slice(0, 3), ["docker", "--context", context]);

    if (
      cleanupBlocked &&
      argv[3] === "rm" &&
      argv[4] === "--force" &&
      argv[5]?.startsWith("loopy-artifact-")
    ) {
      runtime.record({ operation: "injected-helper-cleanup-failure", helper: argv[5] });
      throw new Error("Injected helper cleanup outage before the actual Docker rm.");
    }

    const at = new Date().toISOString();
    const output = await runCommand(argv, options);
    commands.push({ at, argv, ...output });

    return output;
  };

  const docker = async (args: string[]) => {
    const output = await runner(["docker", "--context", context, ...args], {
      timeoutMs: 10_000,
      maxBytes: 128 * 1024,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });

    assert.equal(output.exitCode, 0, `Docker ${args[0]} failed: ${output.stderr}`);

    return output.stdout.trim();
  };

  const backend = new DockerBackend(config, runner);
  const reader = new DockerArtifacts(config, runner);

  const countedBackend: AttemptBackend = {
    async start(receipt, request, signal) {
      plans.set(receipt.id, receipt);
      starts.set(receipt.id, (starts.get(receipt.id) ?? 0) + 1);
      runtime.record({ operation: "backend-start", receipt });
      assert.equal(starts.get(receipt.id), 1, "An attempt must not issue a second backend start.");
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
            status: "active",
          },
          null,
          2,
        ),
      );

      return backend.start(receipt, request, signal);
    },
    async recover(receipt, signal) {
      plans.set(receipt.id, receipt);
      runtime.record({ operation: "backend-recover", receipt });
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
            status: "active",
          },
          null,
          2,
        ),
      );

      return backend.recover(receipt, signal);
    },
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
    const record = await runtime.direct.read(id(request));
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
    assert.equal(state.Config.Labels["loopy.sandbox.owner"], owner);

    return state;
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
    open() {
      return startSandbox(config, async () => ({
        authority: runtime.authority,
        resultsFor: (workspace) => runtime.authority.resultsFor(workspace),
        backend: countedBackend,
        artifactReader: reader,
      }));
    },
    async cleanup() {
      cleanupBlocked = false;
      const errors: unknown[] = [];

      for (const receipt of plans.values()) {
        for (const name of [
          receipt.container,
          `${receipt.container}-input`,
          `loopy-artifact-${receipt.id}`,
        ]) {
          try {
            const state = await inspect(name);

            if (state) {
              assert.equal(state.Config.Labels["loopy.sandbox.request"], receipt.requestHash);

              if (name.startsWith("loopy-artifact-")) {
                assert.equal(state.Config.Labels["loopy.sandbox.role"], "artifact");
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
    async stop(service: Awaited<ReturnType<typeof startSandbox>>) {
      try {
        await bounded(service.close(), "Bridge shutdown", 3000);
      } catch (cause) {
        // Drain this owned fixture even if the public shutdown wrapper regresses.
        await bounded(service.attempts.close(), "Emergency attempts shutdown", 10_000);
        await service.server.stop(true);
        throw cause;
      }
    },
  };
}

export type DockerResources = ReturnType<typeof resources>;

export type Bridge = Awaited<ReturnType<DockerResources["open"]>>;
