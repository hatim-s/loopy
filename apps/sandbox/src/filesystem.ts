import { Effect } from "effect";
import type { ArtifactReader } from "./artifacts.js";
import { DockerArtifacts } from "./artifacts.js";
import type { AttemptDependenciesFactory } from "./attempt-dependencies.js";
import type { SandboxConfig } from "./config.js";
import { type AttemptBackend, DockerBackend } from "./docker.js";
import { FilesystemAuthority } from "./filesystem-authority.js";
import { FilesystemResults } from "./immutable-results.js";

export function filesystemDependencies(
  config: SandboxConfig,
  overrides: { backend?: AttemptBackend; artifactReader?: ArtifactReader } = {},
): AttemptDependenciesFactory {
  return () =>
    Effect.sync(() => {
      const authority = new FilesystemAuthority(config.stateRoot);

      return {
        authority,
        resultsFor: (workspace) => new FilesystemResults(config.stateRoot, workspace),
        backend: overrides.backend ?? new DockerBackend(config),
        artifactReader: overrides.artifactReader ?? new DockerArtifacts(config),
        close: () => authority.close(),
      };
    });
}
