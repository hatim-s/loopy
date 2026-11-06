import { Effect } from "effect";
import type { ArtifactReader } from "../artifacts";
import { DockerArtifacts } from "../artifacts";
import type { AttemptDependenciesFactory } from "../attempt/dependencies";
import type { SandboxConfig } from "../config";
import { type AttemptBackend, DockerBackend } from "../docker";
import { FilesystemResults } from "../immutable-results";
import { FilesystemAuthority } from "./authority";

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
