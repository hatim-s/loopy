import {
  artifactHelperName,
  type DockerAttemptPlan,
  decodeBoundary,
  type SandboxArtifact,
  sandboxArtifactReadSchema,
} from "@loopy/contract";
import type { CommandExecutionError } from "@loopy/runtime/local/execution-host";
import { Effect, Schema } from "effect";
import { verifiedBytes } from "./bytes";
import type { SandboxConfig } from "./config";
import type { DockerClient } from "./docker/client";
import { artifactContainerArgs } from "./docker/plan";
import type { SandboxOperationError } from "./operations";
import { checked, failure } from "./operations";
import { SandboxRequestError } from "./request-error";

type ArtifactFailure = SandboxOperationError | CommandExecutionError | SandboxRequestError;

export interface ArtifactReader {
  cleanup(plan: DockerAttemptPlan): Effect.Effect<void, ArtifactFailure>;
  read(plan: DockerAttemptPlan, path: string): Effect.Effect<SandboxArtifact, ArtifactFailure>;
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
    private readonly docker: DockerClient,
  ) {}

  cleanup(plan: DockerAttemptPlan) {
    return Effect.gen({ self: this }, function* () {
      const docker = this.docker;
      const helper = artifactHelperName(plan.id);

      if (!(yield* docker.exists(helper))) {
        return;
      }

      const inspected = yield* docker.required(["container", "inspect", helper]);

      const labels = (yield* checked("helper labels", () =>
        Schema.decodeUnknownSync(helperSchema)(JSON.parse(inspected.stdout)),
      ))[0]?.Config.Labels;

      if (!labels || !docker.owns(labels, plan.requestHash, "artifact")) {
        return yield* Effect.fail(
          failure("artifacts", new Error("Artifact helper ownership does not match its receipt.")),
        );
      }

      yield* docker.required(["rm", "--force", helper]);

      if (yield* docker.exists(helper)) {
        return yield* Effect.fail(
          failure("artifacts", new Error("Artifact helper removal is not yet confirmed.")),
        );
      }
    });
  }

  private assertIdle(plan: DockerAttemptPlan) {
    return Effect.gen({ self: this }, function* () {
      const docker = this.docker;
      const volume = yield* docker.call(["volume", "inspect", plan.volume]);

      if (volume.exitCode !== 0) {
        const listed = yield* docker.required([
          "volume",
          "ls",
          "--filter",
          `name=^${plan.volume}$`,
          "--format",
          "{{.Name}}",
        ]);

        if (listed.stdout.trim() === "") {
          return yield* Effect.fail(
            new SandboxRequestError("not_found", "Artifact workspace volume was not found."),
          );
        }

        return yield* Effect.fail(
          failure("artifacts", new Error("Cannot inspect the artifact workspace volume.")),
        );
      }

      const mounted = yield* docker.required([
        "container",
        "ls",
        "--all",
        "--filter",
        `volume=${plan.volume}`,
        "--format",
        "{{.ID}}",
      ]);

      const ids = mounted.stdout.trim().split(/\s+/).filter(Boolean);

      if (!ids.every((id) => /^[a-f0-9]{12,64}$/.test(id))) {
        return yield* Effect.fail(
          failure("artifacts", new Error("Docker returned invalid container identities.")),
        );
      }

      if (ids.length === 0) {
        return;
      }

      const states = yield* docker.required(["container", "inspect", ...ids]);

      const active = (yield* checked("mounted containers", () =>
        Schema.decodeUnknownSync(mountedContainersSchema)(JSON.parse(states.stdout)),
      )).some(({ State }) => State.Running || State.Restarting || State.Paused);

      if (active) {
        return yield* Effect.fail(
          new SandboxRequestError(
            "conflict",
            "Workspace still has an active worker. Export after the run is terminal.",
          ),
        );
      }
    });
  }

  read(plan: DockerAttemptPlan, path: string) {
    return Effect.gen({ self: this }, function* () {
      const docker = this.docker;
      yield* this.assertIdle(plan);
      yield* this.cleanup(plan);
      const helper = artifactHelperName(plan.id);

      return yield* Effect.acquireUseRelease(
        Effect.void,
        () =>
          Effect.gen({ self: this }, function* () {
            yield* docker.required(
              artifactContainerArgs(
                this.config,
                plan,
                helper,
                docker.labels(plan.requestHash, "artifact"),
                path,
              ),
            );

            const output = yield* docker.required(["start", "--attach", helper], {
              timeoutMs: 10_000,
              maxBytes: 1_500_000,
            });

            const response = yield* checked("artifact response", () =>
              decodeBoundary(sandboxArtifactReadSchema)(JSON.parse(output.stdout)),
            );

            if (response.kind === "error") {
              return yield* Effect.fail(
                new SandboxRequestError(response.error.code, response.error.message),
              );
            }

            const bytes = verifiedBytes(response.artifact.bytes, response.artifact.sha256);

            if (
              response.artifact.path !== path ||
              bytes === null ||
              bytes.byteLength !== response.artifact.size
            ) {
              return yield* Effect.fail(
                failure("artifacts", new Error("Artifact reader returned inconsistent bytes.")),
              );
            }

            return response.artifact;
          }),
        () => this.cleanup(plan),
      );
    });
  }
}
