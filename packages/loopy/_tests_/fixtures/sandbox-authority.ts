import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { decodeBoundary, type ExecutionResult, nodeIdSchema } from "@loopy/contract";
import {
  attemptRequestHash,
  attemptResources,
  type DockerAttemptPlan,
  sandboxAttemptRequestSchema,
} from "@loopy/contract/sandbox";
import { Effect } from "effect";
import type { ArtifactReader } from "../../../../apps/sandbox/src/artifacts";
import { sandboxConfigSchema } from "../../../../apps/sandbox/src/config";
import type { AttemptBackend } from "../../../../apps/sandbox/src/docker";
import { FilesystemAuthority } from "../../../../apps/sandbox/src/filesystem/authority";
import { FilesystemResults } from "../../../../apps/sandbox/src/filesystem/results";
import { validateStateRoot } from "../../../../apps/sandbox/src/state-root";

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

export async function authorityFixture() {
  const parent = resolve(import.meta.dir, "../../../../.loopy/quality-tests");
  await mkdir(parent, { recursive: true });
  const root = await realpath(await mkdtemp(join(parent, "authority-")));
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
  await mkdir(join(root, ".loopy/loopies"), { recursive: true });

  const config = decodeBoundary(sandboxConfigSchema)({
    worktree: root,
    stateRoot: join(root, ".loopy/cloud/sandbox"),
    token: "sandbox-authority-test-token-32-characters",
    dockerContext: "fixture",
    image: "fixture",
    port: 0,
  });

  await validateStateRoot(config);
  const authority = new FilesystemAuthority(config.stateRoot);
  const resultsFor = (workspace: string) => new FilesystemResults(config.stateRoot, workspace);
  const bytes = Buffer.from("export default () => 1;");
  const hash = createHash("sha256").update(bytes).digest("hex");

  const request = decodeBoundary(sandboxAttemptRequestSchema)({
    workspace: "fixture",
    executionKey: { runId: "run", nodeId: decodeBoundary(nodeIdSchema)("0:code"), scope: [] },
    attempt: 1,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 1000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
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
