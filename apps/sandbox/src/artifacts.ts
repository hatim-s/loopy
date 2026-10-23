import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type SandboxArtifact,
  sandboxArtifactReadSchema,
} from "../../../packages/loopy/src/contract/index.js";
import type { DockerAttemptPlan } from "../../../packages/loopy/src/contract/sandbox-journal.js";
import { ArtifactError } from "./artifact-error.js";
import type { SandboxConfig } from "./config.js";
import { DockerClient } from "./docker-client.js";
import { type CommandRunner, runCommand } from "./process.js";
import type { StoredReceipt } from "./receipts.js";

export interface ArtifactReader {
  cleanup(receipt: DockerAttemptPlan, helper: string): Promise<void>;
  read(
    receipt: Extract<StoredReceipt, { kind: "finished" }>,
    path: string,
  ): Promise<SandboxArtifact>;
}

const mountedContainersSchema = z.array(
  z.object({
    State: z.object({ Running: z.boolean(), Restarting: z.boolean(), Paused: z.boolean() }),
  }),
);

export class DockerArtifacts implements ArtifactReader {
  constructor(
    private readonly config: SandboxConfig,
    private readonly runner: CommandRunner = runCommand,
  ) {}

  private async removeHelper(client: DockerClient, receipt: DockerAttemptPlan, container: string) {
    const listed = await client.required([
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^/${container}$`,
      "--format",
      "{{.Names}}",
    ]);

    if (listed.stdout.trim() === "") {
      return;
    }

    if (listed.stdout.trim() !== container) {
      throw new Error("Artifact helper identity does not match its receipt.");
    }

    const inspected = await client.required(["container", "inspect", container]);

    const labels = z
      .array(z.object({ Config: z.object({ Labels: z.record(z.string(), z.string()) }) }))
      .length(1)
      .parse(JSON.parse(inspected.stdout))[0]?.Config.Labels;

    if (
      !labels ||
      labels["loopy.sandbox.owner"] !== client.owner ||
      labels["loopy.sandbox.request"] !== receipt.requestHash ||
      labels["loopy.sandbox.role"] !== "artifact"
    ) {
      throw new Error("Artifact helper ownership does not match its receipt.");
    }

    await client.required(["rm", "--force", container]);

    const remaining = await client.required([
      "container",
      "ls",
      "--all",
      "--filter",
      `name=^/${container}$`,
      "--format",
      "{{.Names}}",
    ]);

    if (remaining.stdout.trim() !== "") {
      throw new Error("Artifact helper removal is not yet confirmed.");
    }
  }

  async cleanup(receipt: DockerAttemptPlan, helper: string) {
    if (helper !== `loopy-artifact-${receipt.id}`) {
      throw new Error("Artifact helper identity does not match its receipt.");
    }

    await this.removeHelper(new DockerClient(this.config, this.runner), receipt, helper);
  }

  async read(receipt: Extract<StoredReceipt, { kind: "finished" }>, path: string) {
    const client = new DockerClient(this.config, this.runner);
    const volume = await client.call(["volume", "inspect", receipt.volume]);

    if (volume.exitCode !== 0) {
      const listed = await client.required([
        "volume",
        "ls",
        "--filter",
        `name=^${receipt.volume}$`,
        "--format",
        "{{.Name}}",
      ]);

      if (listed.stdout.trim() === "") {
        throw new ArtifactError("not_found", "Artifact workspace volume was not found.");
      }

      throw new Error("Cannot inspect the artifact workspace volume.");
    }

    const mounted = await client.required([
      "container",
      "ls",
      "--all",
      "--filter",
      `volume=${receipt.volume}`,
      "--format",
      "{{.ID}}",
    ]);

    const ids = mounted.stdout.trim().split(/\s+/).filter(Boolean);

    if (!ids.every((id) => /^[a-f0-9]{12,64}$/.test(id))) {
      throw new Error("Docker returned invalid container identities.");
    }

    if (ids.length > 0) {
      const states = await client.required(["container", "inspect", ...ids]);

      if (
        mountedContainersSchema
          .parse(JSON.parse(states.stdout))
          .some(
            (container) =>
              container.State.Running || container.State.Restarting || container.State.Paused,
          )
      ) {
        throw new ArtifactError(
          "conflict",
          "Workspace still has an active worker. Export after the run is terminal.",
        );
      }
    }

    const container = `loopy-artifact-${receipt.id}`;
    await this.removeHelper(client, receipt, container);

    try {
      await client.required([
        "create",
        "--name",
        container,
        "--label",
        `loopy.sandbox.owner=${client.owner}`,
        "--label",
        `loopy.sandbox.request=${receipt.requestHash}`,
        "--label",
        "loopy.sandbox.role=artifact",
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
        "/tmp:rw,noexec,nosuid,size=16m,mode=1777",
        "--memory",
        "128m",
        "--memory-swap",
        "128m",
        "--cpus",
        "0.5",
        "--pids-limit",
        "32",
        "--ulimit",
        "nofile=128:128",
        "--init",
        "--log-driver",
        "none",
        "--mount",
        `type=volume,source=${receipt.volume},target=/workspace,readonly,volume-nocopy`,
        "--workdir",
        "/workspace",
        "--entrypoint",
        "bun",
        this.config.image,
        "/opt/loopy/artifact-worker.js",
        path,
      ]);

      const output = await client.required(["start", "--attach", container], {
        timeoutMs: 10_000,
        maxBytes: 1_500_000,
      });

      const response = sandboxArtifactReadSchema.parse(JSON.parse(output.stdout));

      if (response.kind === "error") {
        throw new ArtifactError(response.error.code, response.error.message);
      }

      const bytes = Buffer.from(response.artifact.bytes, "base64");

      if (
        response.artifact.path !== path ||
        bytes.toString("base64") !== response.artifact.bytes ||
        bytes.byteLength !== response.artifact.size ||
        createHash("sha256").update(bytes).digest("hex") !== response.artifact.sha256
      ) {
        throw new Error("Artifact reader returned inconsistent bytes.");
      }

      return response.artifact;
    } finally {
      await this.removeHelper(client, receipt, container);
    }
  }
}
