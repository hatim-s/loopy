import { access, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { artifactHelperName, inputHelperName } from "@loopy/contract/sandbox";
import { errnoCode } from "@loopy/core";
import { Effect, Schema } from "effect";
import { sandboxConfig, sandboxConfigSchema } from "../../../sandbox/src/config";
import {
  ownerOf,
  SANDBOX_DOCKER_CONTEXT,
  SANDBOX_IMAGE,
  SANDBOX_LABELS,
} from "../../../sandbox/src/docker/identity";
import { runCommand } from "../../../sandbox/src/process";
import { stateLayout } from "../../../sandbox/src/state-root";
import { filesystemReceipt } from "../filesystem-receipt";
import { assert, equal } from "../shared/assert";
import { untilEffect } from "../shared/poll";
import { root } from "../stack/constants";
import { FixtureError, fixtureIO } from "./fixture-effect";

const environment = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? root,
  LANG: "C.UTF-8",
};

type StoredReceipt = Effect.Success<ReturnType<typeof filesystemReceipt>>;

export function command(argv: [string, ...string[]]) {
  return runCommand(argv, { cwd: root, env: environment, timeoutMs: 30_000, maxBytes: 128 * 1024 });
}

export function docker(args: string[]) {
  return Effect.gen(function* () {
    const output = yield* command(["docker", "--context", SANDBOX_DOCKER_CONTEXT, ...args]);
    assert(output.exitCode === 0, "docker_command_failed", { operation: args[0] ?? "" });

    return output.stdout;
  });
}

export function fixture(maxTimeoutMs: number) {
  return Effect.gen(function* () {
    const base = resolve(root, ".loopy/cloud-transport");
    yield* fixtureIO("filesystem", () => mkdir(base, { recursive: true, mode: 0o700 }));
    const directory = yield* fixtureIO("filesystem", () => mkdtemp(resolve(base, "run-")));
    const worktree = resolve(directory, "runtime-root");
    yield* fixtureIO("filesystem", () => mkdir(worktree, { mode: 0o700 }));

    return sandboxConfig(
      decodeBoundary(sandboxConfigSchema)({
        worktree,
        token: "transport-test-fixture-token-32-characters",
        dockerContext: SANDBOX_DOCKER_CONTEXT,
        image: SANDBOX_IMAGE,
        port: 0,
        maxTimeoutMs,
      }),
    );
  });
}

export type Config = Effect.Success<ReturnType<typeof fixture>>;

export function receipts(config: Config) {
  return Effect.gen(function* () {
    const directory = stateLayout(config.stateRoot).receipts;

    const files = (yield* fixtureIO("filesystem", () => readdir(directory))).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    );

    return yield* Effect.all(
      files.map((name) => filesystemReceipt(config.stateRoot, name.slice(0, -5))),
    );
  });
}

export function oneReceipt(config: Config) {
  return Effect.gen(function* () {
    const values = yield* receipts(config);
    equal(values.length, 1, "receipt_count_changed");
    const value = values[0];
    assert(value, "receipt_missing");

    return value;
  });
}

const containerSchema = Schema.Tuple([
  Schema.Struct({
    Id: Schema.String,
    Name: Schema.String,
    Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
    State: Schema.Struct({
      Running: Schema.Boolean,
      StartedAt: Schema.String,
      FinishedAt: Schema.String,
    }),
    Mounts: Schema.Array(
      Schema.Struct({ Type: Schema.String, Name: Schema.optional(Schema.String) }),
    ),
  }),
]);

const decodeContainer = Schema.decodeUnknownSync(containerSchema);

export function ownedContainer(config: Config, receipt: StoredReceipt, name = receipt.container) {
  return Effect.gen(function* () {
    const [row] = decodeContainer(JSON.parse(yield* docker(["container", "inspect", name])));
    equal(row.Name, `/${name}`, "container_name_mismatch");
    equal(
      row.Config.Labels[SANDBOX_LABELS.owner],
      ownerOf(config.stateRoot),
      "container_owner_mismatch",
    );
    equal(row.Config.Labels[SANDBOX_LABELS.request], receipt.requestHash, "request_owner_mismatch");

    return row;
  });
}

export function until<T, E, R>(read: () => Effect.Effect<T, E, R>, accepts: (value: T) => boolean) {
  return untilEffect(read, accepts, {
    timeoutMs: 10_000,
    intervalMs: 50,
    timeout: () =>
      new FixtureError({
        operation: "observation",
        cause: undefined,
        message: "Transport fixture observation timed out.",
      }),
  });
}

export function marker(receipt: StoredReceipt) {
  return Effect.gen(function* () {
    const output = yield* command([
      "docker",
      "--context",
      SANDBOX_DOCKER_CONTEXT,
      "exec",
      receipt.container,
      "cat",
      "/workspace/effect.txt",
    ]);

    return output.exitCode === 0 ? output.stdout : "";
  });
}

export function cleanup(config: Config) {
  return Effect.gen(function* () {
    const saved = yield* receipts(config);
    const removed: string[] = [];
    const volumes = new Set<string>();

    for (const receipt of saved) {
      volumes.add(receipt.inputVolume);
      volumes.add(receipt.volume);

      for (const name of [
        receipt.container,
        inputHelperName(receipt),
        artifactHelperName(receipt.id),
      ]) {
        const listed = (yield* docker([
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^/${name}$`,
          "--format",
          "{{.Names}}",
        ])).trim();

        if (!listed) {
          continue;
        }

        equal(listed, name, "cleanup_container_identity_mismatch");
        const row = yield* ownedContainer(config, receipt, name);
        assert(
          row.Mounts.every((mount) => mount.Type !== "bind"),
          "unexpected_host_bind_mount",
        );

        for (const mount of row.Mounts) {
          if (mount.Type === "volume") {
            assert(mount.Name && volumes.has(mount.Name), "unrecorded_volume_mount");
          }
        }

        yield* docker(["rm", "--force", name]);
        removed.push(name);
      }
    }

    for (const volume of volumes) {
      const listed = (yield* docker([
        "volume",
        "ls",
        "--filter",
        `name=^${volume}$`,
        "--format",
        "{{.Name}}",
      ])).trim();

      if (listed) {
        equal(listed, volume, "cleanup_volume_identity_mismatch");
        yield* docker(["volume", "rm", volume]);
      }

      equal(
        (yield* docker([
          "volume",
          "ls",
          "--filter",
          `name=^${volume}$`,
          "--format",
          "{{.Name}}",
        ])).trim(),
        "",
        "owned_volume_remains",
      );
    }

    equal(
      (yield* docker([
        "container",
        "ls",
        "--all",
        "--filter",
        `label=${SANDBOX_LABELS.owner}=${ownerOf(config.stateRoot)}`,
        "--format",
        "{{.Names}}",
      ])).trim(),
      "",
      "owned_container_remains",
    );

    const lockExists = yield* fixtureIO("filesystem", () =>
      access(stateLayout(config.stateRoot).lock).then(
        () => true,
        (cause: unknown) => {
          if (errnoCode(cause) !== "ENOENT") {
            throw cause;
          }

          return false;
        },
      ),
    );

    assert(!lockExists, "service_lock_remains");

    return {
      containersRemoved: removed,
      volumesCheckedAbsent: [...volumes],
      ownedContainersRemaining: 0,
      ownedVolumesRemaining: 0,
    };
  });
}
