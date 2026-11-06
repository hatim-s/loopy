import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  decodeBoundary,
  type SandboxArtifact,
  sandboxArtifactReadSchema,
} from "../../../packages/loopy/src/contract";
import {
  artifactHelperName,
  type DockerAttemptPlan,
} from "../../../packages/loopy/src/contract/sandbox-journal";
import type { CommandExecutionError } from "../../../packages/loopy/src/core";
import { ArtifactError } from "./artifact-error";
import type { SandboxConfig } from "./config";
import { DockerClient } from "./docker/client";
import type { SandboxOperationError } from "./operations";
import { checked, failure } from "./operations";
import { type CommandRunner, runCommand } from "./process";

export interface ArtifactReader {
  cleanup(
    receipt: DockerAttemptPlan,
    helper: string,
  ): Effect.Effect<void, SandboxOperationError | CommandExecutionError | ArtifactError>;
  read(
    receipt: DockerAttemptPlan,
    path: string,
  ): Effect.Effect<SandboxArtifact, SandboxOperationError | CommandExecutionError | ArtifactError>;
}

const mountedContainersSchema = Schema.Array(
  Schema.Struct({
    State: Schema.Struct({
      Running: Schema.Boolean,
      Restarting: Schema.Boolean,
      Paused: Schema.Boolean,
    }),
  }),
);

const helperSchema = Schema.Array(
  Schema.Struct({ Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }) }),
).check(Schema.makeFilter((items) => items.length === 1));

export class DockerArtifacts implements ArtifactReader {
  constructor(
    private readonly config: SandboxConfig,
    private readonly runner: CommandRunner = runCommand,
  ) {}

  private removeHelper(client: DockerClient, receipt: DockerAttemptPlan, container: string) {
    return Effect.gen({ self: this }, function* () {
      const listed = yield* client.required([
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
        return yield* Effect.fail(
          failure("artifacts", new Error("Artifact helper identity does not match its receipt.")),
        );
      }

      const inspected = yield* client.required(["container", "inspect", container]);

      const labels = (yield* checked("helper labels", () =>
        Schema.decodeUnknownSync(helperSchema)(JSON.parse(inspected.stdout)),
      ))[0]?.Config.Labels;

      if (
        !labels ||
        labels["loopy.sandbox.owner"] !== client.owner ||
        labels["loopy.sandbox.request"] !== receipt.requestHash ||
        labels["loopy.sandbox.role"] !== "artifact"
      ) {
        return yield* Effect.fail(
          failure("artifacts", new Error("Artifact helper ownership does not match its receipt.")),
        );
      }

      yield* client.required(["rm", "--force", container]);

      const remaining = yield* client.required([
        "container",
        "ls",
        "--all",
        "--filter",
        `name=^/${container}$`,
        "--format",
        "{{.Names}}",
      ]);

      if (remaining.stdout.trim() !== "") {
        return yield* Effect.fail(
          failure("artifacts", new Error("Artifact helper removal is not yet confirmed.")),
        );
      }
    });
  }

  cleanup(receipt: DockerAttemptPlan, helper: string) {
    return Effect.gen({ self: this }, function* () {
      if (helper !== artifactHelperName(receipt.id)) {
        return yield* Effect.fail(
          failure("artifacts", new Error("Artifact helper identity does not match its receipt.")),
        );
      }

      yield* this.removeHelper(new DockerClient(this.config, this.runner), receipt, helper);
    });
  }

  read(receipt: DockerAttemptPlan, path: string) {
    return Effect.gen({ self: this }, function* () {
      const client = new DockerClient(this.config, this.runner);
      const volume = yield* client.call(["volume", "inspect", receipt.volume]);

      if (volume.exitCode !== 0) {
        const listed = yield* client.required([
          "volume",
          "ls",
          "--filter",
          `name=^${receipt.volume}$`,
          "--format",
          "{{.Name}}",
        ]);

        if (listed.stdout.trim() === "") {
          return yield* Effect.fail(
            new ArtifactError("not_found", "Artifact workspace volume was not found."),
          );
        }

        return yield* Effect.fail(
          failure("artifacts", new Error("Cannot inspect the artifact workspace volume.")),
        );
      }

      const mounted = yield* client.required([
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
        return yield* Effect.fail(
          failure("artifacts", new Error("Docker returned invalid container identities.")),
        );
      }

      if (ids.length > 0) {
        const states = yield* client.required(["container", "inspect", ...ids]);

        if (
          (yield* checked("mounted containers", () =>
            Schema.decodeUnknownSync(mountedContainersSchema)(JSON.parse(states.stdout)),
          )).some(
            (container) =>
              container.State.Running || container.State.Restarting || container.State.Paused,
          )
        ) {
          return yield* Effect.fail(
            new ArtifactError(
              "conflict",
              "Workspace still has an active worker. Export after the run is terminal.",
            ),
          );
        }
      }

      const container = artifactHelperName(receipt.id);
      yield* this.removeHelper(client, receipt, container);

      return yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen({ self: this }, function* () {
            yield* client.required([
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

            const output = yield* client.required(["start", "--attach", container], {
              timeoutMs: 10_000,
              maxBytes: 1_500_000,
            });

            const response = yield* checked("artifact response", () =>
              decodeBoundary(sandboxArtifactReadSchema)(JSON.parse(output.stdout)),
            );

            if (response.kind === "error") {
              return yield* Effect.fail(
                new ArtifactError(response.error.code, response.error.message),
              );
            }

            const bytes = Buffer.from(response.artifact.bytes, "base64");

            if (
              response.artifact.path !== path ||
              bytes.toString("base64") !== response.artifact.bytes ||
              bytes.byteLength !== response.artifact.size ||
              createHash("sha256").update(bytes).digest("hex") !== response.artifact.sha256
            ) {
              return yield* Effect.fail(
                failure("artifacts", new Error("Artifact reader returned inconsistent bytes.")),
              );
            }

            return response.artifact;
          }),
        () =>
          Effect.gen({ self: this }, function* () {
            yield* this.removeHelper(client, receipt, container);
          }),
      );
    });
  }
}
