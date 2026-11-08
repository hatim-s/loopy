import { afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { decodeBoundary, type ExecutionResult, nodeIdSchema } from "@loopy/contract";
import { type SandboxAttemptRequest, sandboxAttemptRequestSchema } from "@loopy/contract/sandbox";
import { Effect } from "effect";
import type { ArtifactReader } from "../../src/artifacts";
import type { Attempts } from "../../src/attempt";
import type { AttemptDependenciesFactory } from "../../src/attempt/dependencies";
import type { SandboxConfig } from "../../src/config";
import type { AttemptBackend } from "../../src/docker";
import { filesystemStorage } from "../../src/filesystem";
import { FilesystemJournal } from "../../src/filesystem/journal";
import { artifactReader as idleArtifactReader, sandboxFixtureConfig } from "./authority";
import { openAttempts, run } from "./run";

export const succeeded: ExecutionResult = { kind: "succeeded", output: { ok: true }, logs: [] };

export const fixture = () => sandboxFixtureConfig("cloud-sandbox");

export function request(
  source = "process.stdout.write(JSON.stringify({ok:true}))",
): SandboxAttemptRequest {
  const bytes = Buffer.from(source);
  const hash = createHash("sha256").update(bytes).digest("hex");

  return decodeBoundary(sandboxAttemptRequestSchema)({
    workspace: "workspace-one",
    executionKey: { runId: "run-one", nodeId: decodeBoundary(nodeIdSchema)("0:code"), scope: [] },
    attempt: 1,
    spec: { kind: "code", bundleHash: hash, input: {}, timeoutMs: 1000 },
    bundles: [{ hash, bytes: bytes.toString("base64") }],
  });
}

export function dependencies(
  config: SandboxConfig,
  backend: AttemptBackend,
  artifactReader: ArtifactReader = idleArtifactReader,
): AttemptDependenciesFactory {
  return () =>
    Effect.sync(() => ({ ...filesystemStorage(config.stateRoot), backend, artifactReader }));
}

export function diskReceipts(root: string) {
  return run(new FilesystemJournal(root).records());
}

/**
 * Opens attempt services that close after each test, before the test scope releases their roots.
 * Call it at the top of a test file, so the hook belongs to that file.
 */
export function attemptServices() {
  const services: Attempts[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => run(service.close())));
  });

  return {
    services,
    async open(config: SandboxConfig, backend: AttemptBackend, artifactReader?: ArtifactReader) {
      const service = await openAttempts(config, dependencies(config, backend, artifactReader));

      services.push(service);

      return service;
    },
  };
}
