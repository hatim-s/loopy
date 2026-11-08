import { mkdir, mkdtemp } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeBoundary } from "@loopy/contract";
import { Effect } from "effect";
import { sandboxConfig, sandboxConfigSchema } from "../../../sandbox/src/config";
import { SANDBOX_DOCKER_CONTEXT, SANDBOX_IMAGE } from "../../../sandbox/src/docker/identity";
import { runCommand } from "../../../sandbox/src/process";
import { stateLayout } from "../../../sandbox/src/state-root";
import type { StoredReceipt } from "../filesystem-receipt";
import { assert, equal } from "../shared/assert";
import { lstatOrAbsent } from "../shared/fs";
import { untilEffect } from "../shared/poll";
import { docker as runDocker } from "../shared/process";
import { root } from "../stack/constants";
import { OwnedResources } from "../stack/owned";
import { FixtureError, fixtureIO } from "./fixture-effect";

const environment = {
  PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  HOME: process.env.HOME ?? root,
  LANG: "C.UTF-8",
};

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

function owned(config: Config) {
  return new OwnedResources(config.stateRoot, (args) =>
    runDocker(args, { env: environment, timeoutMs: 30_000 }),
  );
}

export function receipts(config: Config) {
  return fixtureIO("filesystem", () => owned(config).receipts());
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

export function ownedContainer(config: Config, receipt: StoredReceipt) {
  return fixtureIO("docker", () => owned(config).container(receipt));
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
    const evidence = yield* fixtureIO("cleanup", () => owned(config).remove());

    const lock = yield* fixtureIO("filesystem", () =>
      lstatOrAbsent(stateLayout(config.stateRoot).lock),
    );

    assert(!lock, "service_lock_remains");

    return evidence;
  });
}
