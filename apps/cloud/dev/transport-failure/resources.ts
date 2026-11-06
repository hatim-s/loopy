import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Effect } from "effect";
import { z } from "zod";
import { sandboxConfigSchema } from "../../../sandbox/src/config";
import { runCommand } from "../../../sandbox/src/process";
import type { StoredReceipt } from "../../../sandbox/src/receipts";
import { filesystemReceipt } from "../filesystem-receipt";
import { FixtureError, fixtureIO } from "../fixture-effect";
import { assert, equal } from "../journey/client";

export const root = resolve(import.meta.dir, "../../../..");

export const context = "colima-loopy-cloud-phase1";

export const image = "loopy-sandbox:bun-1.4.0";

export const environment = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? root,
  LANG: "C.UTF-8",
};

export function command(argv: string[]) {
  return runCommand(argv, { env: environment, timeoutMs: 30_000, maxBytes: 128 * 1024 });
}

export function docker(args: string[]) {
  return Effect.gen(function* () {
    const output = yield* command(["docker", "--context", context, ...args]);
    assert(output.exitCode === 0, "docker_command_failed", { operation: args[0] ?? "" });

    return output.stdout;
  });
}

export function fixture() {
  return Effect.gen(function* () {
    const base = resolve(root, ".loopy/cloud-transport");
    yield* fixtureIO("filesystem", () => mkdir(base, { recursive: true, mode: 0o700 }));
    const directory = yield* fixtureIO("filesystem", () => mkdtemp(resolve(base, "run-")));
    const worktree = resolve(directory, "runtime-root");
    yield* fixtureIO("filesystem", () => mkdir(worktree, { mode: 0o700 }));

    return decodeBoundary(sandboxConfigSchema)({
      worktree,
      stateRoot: resolve(worktree, ".loopy/cloud/sandbox"),
      token: "transport-test-fixture-token-32-characters",
      dockerContext: context,
      image,
      port: 0,
      maxTimeoutMs: 20_000,
    });
  });
}

export type Config = Effect.Success<ReturnType<typeof fixture>>;

export const ownerOf = (config: Config) =>
  createHash("sha256").update(config.stateRoot).digest("hex");

export function receipts(config: Config) {
  return Effect.gen(function* () {
    const directory = resolve(config.stateRoot, "receipts");

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

const containerSchema = z
  .array(
    z.object({
      Id: z.string(),
      Name: z.string(),
      Config: z.object({ Labels: z.record(z.string(), z.string()) }),
      State: z.object({ Running: z.boolean(), StartedAt: z.string(), FinishedAt: z.string() }),
      Mounts: z.array(z.object({ Type: z.string(), Name: z.string().optional() })),
    }),
  )
  .length(1);

export function ownedContainer(config: Config, receipt: StoredReceipt, name = receipt.container) {
  return Effect.gen(function* () {
    const row = containerSchema.parse(JSON.parse(yield* docker(["container", "inspect", name])))[0];
    assert(row, "container_missing");
    equal(row.Name, `/${name}`, "container_name_mismatch");
    equal(row.Config.Labels["loopy.sandbox.owner"], ownerOf(config), "container_owner_mismatch");
    equal(
      row.Config.Labels["loopy.sandbox.request"],
      receipt.requestHash,
      "request_owner_mismatch",
    );

    return row;
  });
}

export function until<T, E, R>(read: () => Effect.Effect<T, E, R>, accepts: (value: T) => boolean) {
  return Effect.gen(function* () {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      const value = yield* read();

      if (accepts(value)) {
        return value;
      }

      yield* Effect.sleep(50);
    }

    return yield* Effect.fail(
      new FixtureError({
        operation: "observation",
        cause: undefined,
        message: "Transport fixture observation timed out.",
      }),
    );
  });
}

export function marker(receipt: StoredReceipt) {
  return Effect.gen(function* () {
    const output = yield* command([
      "docker",
      "--context",
      context,
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
        `${receipt.container}-input`,
        `loopy-artifact-${receipt.id}`,
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
        `label=loopy.sandbox.owner=${ownerOf(config)}`,
        "--format",
        "{{.Names}}",
      ])).trim(),
      "",
      "owned_container_remains",
    );

    for (const name of ["service.lock", "service-start.lock"]) {
      let exists = true;
      yield* fixtureIO("filesystem", () =>
        access(resolve(config.stateRoot, name)).catch((cause: unknown) => {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
            throw cause;
          }

          exists = false;
        }),
      );
      assert(!exists, "service_lock_remains");
    }

    return {
      containersRemoved: removed,
      volumesCheckedAbsent: [...volumes],
      ownedContainersRemaining: 0,
      ownedVolumesRemaining: 0,
    };
  });
}
