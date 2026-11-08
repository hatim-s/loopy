import { resolve } from "node:path";
import { Effect } from "effect";
import { assert, equal } from "../shared/assert";
import { sourceHashes } from "../shared/hash";
import { DOCKER_CONTEXT, root, SANDBOX_IMAGE } from "../stack/constants";
import { fixtureIO } from "./fixture-effect";
import { command, docker, fixture } from "./resources";
import { maxTimeoutMs, scenario } from "./scenario";

await Effect.runPromise(
  Effect.gen(function* () {
    const startedAt = new Date().toISOString();

    const evidencePath = resolve(root, ".notes/cloud/evidence/transport-failure.json");

    const sourcePaths = [
      ...(yield* fixtureIO("script evidence", () =>
        Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: resolve(root, "apps/sandbox/src") })),
      )).map((name) => `apps/sandbox/src/${name}`),
      "packages/runtime/src/os/spawn.ts",
      "packages/runtime/src/executor/protocol.ts",
      "packages/contract/src/sandbox.ts",
      ...["index.ts", "resources.ts", "faults.ts", "scenario.ts"].map(
        (name) => `apps/cloud/dev/transport-failure/${name}`,
      ),
    ];

    const head = (yield* command(["git", "rev-parse", "HEAD"])).stdout.trim();

    const branch = (yield* command(["git", "branch", "--show-current"])).stdout.trim();

    equal(process.cwd(), root, "wrong_worktree_directory");

    const before = yield* fixtureIO("script evidence", () => sourceHashes(root, sourcePaths));

    const imageId = (yield* docker([
      "image",
      "inspect",
      SANDBOX_IMAGE,
      "--format",
      "{{.Id}}",
    ])).trim();

    assert(/^sha256:[a-f0-9]{64}$/.test(imageId), "image_missing");

    const results: Effect.Success<ReturnType<typeof scenario>>[] = [];

    for (const mode of ["kill_wait_client", "unavailable_inspect_socket"] as const) {
      const config = yield* fixture(maxTimeoutMs[mode]);
      const result = yield* scenario(config, mode);
      results.push(result);
      process.stdout.write(
        `${JSON.stringify({ mode, status: result.status, failure: result.failure, cleanup: result.cleanup })}\n`,
      );
    }

    const after = yield* fixtureIO("script evidence", () => sourceHashes(root, sourcePaths));

    equal(after, before, "source_changed_during_transport_proof");

    equal(
      (yield* docker(["image", "inspect", SANDBOX_IMAGE, "--format", "{{.Id}}"])).trim(),
      imageId,
      "image_changed_during_proof",
    );

    const status = results.every((result) => result.status === "passed") ? "passed" : "failed";

    yield* fixtureIO("script evidence", () =>
      Bun.write(
        evidencePath,
        `${JSON.stringify(
          {
            status,
            scope: "local-real-docker-cli-transport-faults",
            command:
              'env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 bun --no-env-file apps/cloud/dev/transport-failure/index.ts',
            startedAt,
            finishedAt: new Date().toISOString(),
            identity: {
              worktree: root,
              branch,
              head,
              bun: Bun.version,
              dockerContext: DOCKER_CONTEXT,
              image: SANDBOX_IMAGE,
              imageId,
            },
            boundaries: {
              portsOpened: [],
              stateBase: resolve(root, ".loopy/cloud-transport"),
              sourceEdits: false,
              daemonStopped: false,
              credentialsUsed: false,
              contextChanged: false,
            },
            limitations: [
              "Fault injection wraps the existing CommandRunner parameter inside this test process.",
              "wait failure kills an actual docker wait client. inspect and fallback ls failures execute the actual Docker CLI against an absent Unix socket selected for those invocations only.",
              "Successful Docker commands, ownership inspections, worker execution, receipts, artifacts and deadline termination use the real named context. No Docker state or result is mocked.",
              "Attempts is closed and reopened in the same test process. This is service-object reconstruction, not an operating-system process crash.",
              "The shared daemon remains available. This does not prove a daemon outage, network partition, remote provider behavior, Modal parity or browser acceptance.",
              "The existing image is pinned by image ID and its bundled worker hash. It was not rebuilt from the inspected host source.",
            ],
            sourceHashes: before,
            sourceHashesUnchanged: true,
            results,
          },
          null,
          2,
        )}\n`,
      ),
    );

    process.exitCode = status === "passed" ? 0 : 1;
  }),
);
