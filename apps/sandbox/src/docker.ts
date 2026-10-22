import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  SANDBOX_MAX_CAPTURE_BYTES,
  type SandboxAttemptRequest,
  type SandboxExecutionResult,
  sandboxExecutionResultSchema,
} from "../../../packages/loopy/src/contract/index.js";
import type { SandboxConfig } from "./config.js";
import { DockerClient } from "./docker-client.js";
import { CaptureError, type CommandRunner, runCommand } from "./process.js";
import type { StartedReceipt } from "./receipts.js";
import { boundedResult, failed } from "./result.js";

const inspectionSchema = z
  .array(
    z.object({
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      State: z.object({
        Status: z.string(),
        Running: z.boolean(),
        ExitCode: z.number(),
        OOMKilled: z.boolean(),
      }),
    }),
  )
  .length(1);

export interface AttemptBackend {
  start(
    receipt: StartedReceipt,
    request: SandboxAttemptRequest,
    signal?: AbortSignal,
  ): Promise<SandboxExecutionResult>;
  recover(receipt: StartedReceipt, signal?: AbortSignal): Promise<SandboxExecutionResult>;
}

export class DockerBackend implements AttemptBackend {
  constructor(
    private readonly config: SandboxConfig,
    private readonly runner: CommandRunner = runCommand,
  ) {}

  private async inspect(client: DockerClient, receipt: StartedReceipt) {
    const output = await client.call(["container", "inspect", receipt.container]);

    if (output.exitCode !== 0) {
      const listed = await client.required([
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

      throw new Error("Cannot inspect the owned attempt container.");
    }

    const container = inspectionSchema.parse(JSON.parse(output.stdout))[0];

    if (
      !container ||
      container.Config.Labels["loopy.sandbox.owner"] !== client.owner ||
      container.Config.Labels["loopy.sandbox.request"] !== receipt.requestHash
    ) {
      throw new Error("Attempt container ownership does not match its durable receipt.");
    }

    return container.State;
  }

  async start(receipt: StartedReceipt, request: SandboxAttemptRequest, signal?: AbortSignal) {
    const client = new DockerClient(this.config, this.runner, signal);
    const directory = await mkdtemp(join(this.config.stateRoot, "staging", "attempt-"));

    try {
      await writeFile(join(directory, "request.json"), JSON.stringify(request.spec), {
        mode: 0o444,
      });

      for (const bundle of request.bundles) {
        await writeFile(
          join(directory, `${bundle.hash}.mjs`),
          Buffer.from(bundle.bytes, "base64"),
          { mode: 0o444 },
        );
      }

      // Docker cannot copy into a read-only root. A stopped helper fills a dedicated
      // volume, then the execution container mounts that input volume read-only.
      const helper = `${receipt.container}-input`;
      await client.required([
        "create",
        "--name",
        helper,
        "--label",
        `loopy.sandbox.owner=${client.owner}`,
        "--label",
        `loopy.sandbox.request=${receipt.requestHash}`,
        "--network",
        "none",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--read-only",
        "--mount",
        `type=volume,source=${receipt.inputVolume},target=/input`,
        this.config.image,
      ]);
      await client.required(["cp", `${directory}/.`, `${helper}:/input/`]);
      await client.required(["rm", helper]);
      await client.required([
        "create",
        "--name",
        receipt.container,
        "--label",
        `loopy.sandbox.owner=${client.owner}`,
        "--label",
        `loopy.sandbox.request=${receipt.requestHash}`,
        "--network",
        "none",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
        "--memory",
        this.config.memory,
        "--memory-swap",
        this.config.memory,
        "--cpus",
        String(this.config.cpus),
        "--pids-limit",
        String(this.config.pids),
        "--ulimit",
        "nofile=256:256",
        "--init",
        "--log-driver",
        "local",
        "--log-opt",
        "max-size=4m",
        "--log-opt",
        "max-file=1",
        "--log-opt",
        "compress=false",
        "--mount",
        `type=volume,source=${receipt.volume},target=/workspace`,
        "--mount",
        `type=volume,source=${receipt.inputVolume},target=/input,readonly`,
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/workspace",
        "--env",
        "TMPDIR=/tmp",
        "--entrypoint",
        "bun",
        this.config.image,
        "/opt/loopy/worker.js",
      ]);

      if (Date.now() >= receipt.deadline) {
        return failed("execution", "Attempt timed out before its container started.");
      }

      await client.required(["start", receipt.container]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    return this.recover(receipt, signal);
  }

  private async waitForWorker(client: DockerClient, receipt: StartedReceipt) {
    const remaining = receipt.deadline - Date.now();

    try {
      if (remaining <= 0) {
        throw new CaptureError("timeout");
      }

      await client.required(["wait", receipt.container], {
        timeoutMs: remaining,
        maxBytes: 1024,
      });
    } catch (cause) {
      if (!(cause instanceof CaptureError && cause.reason === "timeout")) {
        throw cause;
      }

      const current = await this.inspect(client, receipt);

      if (current?.Running) {
        await client.required(["kill", receipt.container]);
      }

      const stopped = await this.inspect(client, receipt);

      if (stopped?.Running) {
        throw new Error("Attempt container termination is not yet confirmed.");
      }

      return "timed_out" as const;
    }

    return "stopped" as const;
  }

  async recover(receipt: StartedReceipt, signal?: AbortSignal): Promise<SandboxExecutionResult> {
    const client = new DockerClient(this.config, this.runner, signal);
    const state = await this.inspect(client, receipt);

    if (state?.Status === "created") {
      // Removing a never-started container also fences a Docker start whose acknowledgement was lost.
      await client.required(["rm", "--force", receipt.container]);

      if ((await this.inspect(client, receipt)) !== null) {
        throw new Error("Attempt container removal is not yet confirmed.");
      }
    }

    if (state === null || state.Status === "created") {
      return failed(
        "uncertain",
        "Attempt has a started receipt but no started worker. It will not be repeated.",
      );
    }

    if (state.Running && (await this.waitForWorker(client, receipt)) === "timed_out") {
      return failed("execution", "Attempt timed out. Its owned container was killed.");
    }

    const final = await this.inspect(client, receipt);

    if (final?.Running) {
      throw new Error("Attempt worker remains running after Docker wait.");
    }

    if (!final || final.Status !== "exited" || final.ExitCode !== 0 || final.OOMKilled) {
      return failed(
        "uncertain",
        "Attempt worker disappeared or exited without a terminal result. It will not be repeated.",
      );
    }

    try {
      const output = await client.required(["logs", receipt.container], {
        timeoutMs: 30_000,
        maxBytes: SANDBOX_MAX_CAPTURE_BYTES,
      });

      return boundedResult(sandboxExecutionResultSchema.parse(JSON.parse(output.stdout)));
    } catch (cause) {
      if (cause instanceof CaptureError && cause.reason === "output_limit") {
        return failed("output_limit", "Attempt worker output exceeded its byte limit.");
      }

      return failed(
        "uncertain",
        "Attempt worker did not leave a valid terminal result. It will not be repeated.",
      );
    }
  }
}
