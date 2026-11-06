import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Effect } from "effect";
import { fixtureIO } from "../fixture-effect";
import { assert, equal } from "../journey/client";
import { command, context, docker, fixture, image, root } from "./resources";
import { scenario } from "./scenario";

await Effect.runPromise(
  Effect.gen(function* () {
    const startedAt = new Date().toISOString();

    const evidencePath = resolve(root, ".notes/cloud/evidence/transport-failure.json");

    const sourcePaths = [
      ...(yield* fixtureIO("script evidence", () =>
        Array.fromAsync(new Bun.Glob("**/*.ts").scan({ cwd: resolve(root, "apps/sandbox/src") })),
      )).map((name) => `apps/sandbox/src/${name}`),
      "packages/loopy/src/local/spawn.ts",
      "packages/loopy/src/executor/protocol.ts",
      "packages/loopy/src/contract/sandbox.ts",
      ...["index.ts", "resources.ts", "faults.ts", "scenario.ts"].map(
        (name) => `scripts/cloud/transport-failure/${name}`,
      ),
    ];

    async function sourceHashes() {
      return Object.fromEntries(
        await Promise.all(
          sourcePaths.map(async (path) => [
            path,
            createHash("sha256")
              .update(new Uint8Array(await Bun.file(resolve(root, path)).arrayBuffer()))
              .digest("hex"),
          ]),
        ),
      );
    }

    const head = (yield* command(["git", "rev-parse", "HEAD"])).stdout.trim();

    const branch = (yield* command(["git", "branch", "--show-current"])).stdout.trim();

    equal(process.cwd(), root, "wrong_worktree_directory");

    equal(root, "/Users/hatim.shakir/projects/loopy/cloud-integration", "wrong_worktree");

    equal(branch, "cloud-integration", "wrong_branch");

    const before = yield* fixtureIO("script evidence", () => sourceHashes());

    const imageId = (yield* docker(["image", "inspect", image, "--format", "{{.Id}}"])).trim();

    assert(/^sha256:[a-f0-9]{64}$/.test(imageId), "image_missing");

    const results: Effect.Success<ReturnType<typeof scenario>>[] = [];

    for (const mode of ["kill_wait_client", "unavailable_inspect_socket"] as const) {
      const config = yield* fixture();
      const result = yield* scenario(config, mode);
      results.push(result);
      process.stdout.write(
        `${JSON.stringify({ mode, status: result.status, failure: result.failure, cleanup: result.cleanup })}\n`,
      );
    }

    const after = yield* fixtureIO("script evidence", () => sourceHashes());

    equal(after, before, "source_changed_during_transport_proof");

    equal(
      (yield* docker(["image", "inspect", image, "--format", "{{.Id}}"])).trim(),
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
              'env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 bun --no-env-file scripts/cloud/transport-failure/index.ts',
            startedAt,
            finishedAt: new Date().toISOString(),
            identity: {
              worktree: root,
              branch,
              head,
              bun: Bun.version,
              dockerContext: context,
              image,
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
