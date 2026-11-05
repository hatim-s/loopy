import type { Effect } from "effect";
import type { ArtifactReader } from "./artifacts.js";
import type { AttemptBackend } from "./docker.js";
import type { ResultsFor, SandboxAttemptAuthority, SandboxFailure } from "./operations.js";

export interface AttemptDependencies {
  authority: SandboxAttemptAuthority;
  resultsFor: ResultsFor;
  backend: AttemptBackend;
  artifactReader: ArtifactReader;
  close?: () => Effect.Effect<void, SandboxFailure>;
}

export type AttemptDependenciesFactory = () => Effect.Effect<AttemptDependencies, SandboxFailure>;
