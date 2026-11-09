import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeBoundary, type ExecutionResult, nodeIdSchema } from "@loopy/contract";
import {
  attemptRequestHash,
  attemptResources,
  type DockerAttemptPlan,
  sandboxAttemptRequestSchema,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import { qualityTestRoot } from "../../../../packages/runtime/_tests_/fixtures/quality-test-root";
import type { ArtifactReader } from "../../src/artifacts";
import { sandboxConfig, sandboxConfigSchema } from "../../src/config";
import type { AttemptBackend } from "../../src/docker";
import { SANDBOX_DOCKER_CONTEXT, SANDBOX_IMAGE } from "../../src/docker/identity";
import { FilesystemAuthority } from "../../src/filesystem/authority";
import { FilesystemResults } from "../../src/filesystem/results";
import { validateStateRoot } from "../../src/state-root";

export const successful: ExecutionResult = {
  kind: "succeeded",
  output: { ok: true },
  logs: [],
};

export const uncertain: ExecutionResult = {
  kind: "failed",
  error: { code: "uncertain", message: "No worker" },
  exitCode: null,
  logs: [],
};

/** Starts return `result` and recovery reports uncertain, and both are counted. */
export class CountingBackend implements AttemptBackend {
  starts = 0;
  recoveries = 0;

  constructor(
    private readonly result: Effect.Effect<ExecutionResult> = Effect.succeed(successful),
  ) {}

  start() {
    return Effect.suspend(() => {
      this.starts++;

      return this.result;
    });
  }

  recover() {
    return Effect.sync(() => {
      this.recoveries++;

      return uncertain;
    });
  }
}

export const succeedingBackend: AttemptBackend = {
  start: () => Effect.succeed(successful),
  recover: () => Effect.succeed(successful),
};

export const artifactReader: ArtifactReader = {
  cleanup: () => Effect.void,
  read: (...[, path]) =>
    Effect.gen(function* () {
      return {
        path,
        bytes: "",
        size: 0,
        sha256: createHash("sha256").update("").digest("hex"),
      };
    }),
};

export const FIXTURE_TOKEN = "sandbox-fixture-token-32-characters";

/** A first-attempt code request whose one bundle is `source`. */
export function codeRequest(options: { workspace: string; runId: string; source: string }) {
  const bytes = Buffer.from(options.source);
  const hash = createHash("sha256").update(bytes).digest("hex");

  return decodeBoundary(sandboxAttemptRequestSchema)({
    workspace: options.workspace,
    executionKey: {
      runId: options.runId,
      nodeId: decodeBoundary(nodeIdSchema)("0:code"),
      scope: [],
    },
    attempt: 1,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 1000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
  });
}

/** A validated sandbox config on its own repository-local worktree. */
export async function sandboxFixtureConfig(name: string) {
  const root = qualityTestRoot(name);
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));

  const config = sandboxConfig(
    decodeBoundary(sandboxConfigSchema)({
      worktree: root,
      token: FIXTURE_TOKEN,
      dockerContext: SANDBOX_DOCKER_CONTEXT,
      image: SANDBOX_IMAGE,
      port: 0,
    }),
  );

  await validateStateRoot(config);

  return config;
}

export async function authorityFixture() {
  const config = await sandboxFixtureConfig("authority");
  const root = config.worktree;
  const authority = new FilesystemAuthority(config.stateRoot);
  const resultsFor = (workspace: string) => new FilesystemResults(config.stateRoot, workspace);

  const request = codeRequest({
    workspace: "fixture",
    runId: "run",
    source: "export default () => 1;",
  });

  async function plan(attempt = 1, runId = "run"): Promise<DockerAttemptPlan> {
    const identity = {
      workspace: request.workspace,
      executionKey: { ...request.executionKey, runId },
      attempt,
    };

    return {
      ...identity,
      ...(await attemptResources(config.stateRoot, identity)),
      requestHash: await attemptRequestHash({ ...request, ...identity }),
      deadline: 123456789,
    };
  }

  return { root, config, authority, resultsFor, request, plan };
}
