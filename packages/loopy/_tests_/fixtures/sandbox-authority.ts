import { createHash } from "node:crypto";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attemptHash } from "../../../../apps/sandbox/src/admission.js";
import type { ArtifactReader } from "../../../../apps/sandbox/src/artifacts.js";
import { sandboxConfigSchema, validateStateRoot } from "../../../../apps/sandbox/src/config.js";
import { FilesystemAuthority } from "../../../../apps/sandbox/src/filesystem-authority.js";
import { FilesystemResults } from "../../../../apps/sandbox/src/immutable-results.js";
import {
  nodeIdSchema,
  type SandboxExecutionResult,
  sandboxAttemptRequestSchema,
} from "../../src/contract/index.js";
import type { DockerAttemptPlan } from "../../src/contract/sandbox-journal.js";

export const successful: SandboxExecutionResult = {
  kind: "succeeded",
  output: { ok: true },
  logs: [],
};

export const uncertain: SandboxExecutionResult = {
  kind: "failed",
  error: { code: "uncertain", message: "No worker" },
  exitCode: null,
  logs: [],
};

export const artifactReader: ArtifactReader = {
  cleanup: async () => {},
  read: async (...[, path]) => ({
    path,
    bytes: "",
    size: 0,
    sha256: createHash("sha256").update("").digest("hex"),
  }),
};

export async function authorityFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopy-authority-")));

  const config = sandboxConfigSchema.parse({
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

  const request = sandboxAttemptRequestSchema.parse({
    workspace: "fixture",
    executionKey: { runId: "run", nodeId: nodeIdSchema.parse("0:code"), scope: [] },
    attempt: 1,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 1000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
  });

  function plan(attempt = 1, runId = "run"): DockerAttemptPlan {
    const identity = {
      workspace: request.workspace,
      executionKey: { ...request.executionKey, runId },
      attempt,
    };

    const id = attemptHash({ ...identity, root: config.stateRoot });

    return {
      ...identity,
      id,
      requestHash: attemptHash({ ...request, ...identity }),
      container: `loopy-attempt-${id}`,
      inputVolume: `loopy-input-${id}`,
      volume: `loopy-workspace-${attemptHash({ root: config.stateRoot, workspace: identity.workspace, runId })}`,
      deadline: 123456789,
    };
  }

  return { root, config, authority, resultsFor, request, plan };
}
