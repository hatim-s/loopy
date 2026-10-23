import type { ResultsFor } from "../../../packages/loopy/src/contract/sandbox-journal.js";
import type { SandboxAttemptAuthority } from "../../../packages/loopy/src/contract/sandbox-journal-rpc.js";
import type { ArtifactReader } from "./artifacts.js";
import type { AttemptBackend } from "./docker.js";

export interface AttemptDependencies {
  authority: SandboxAttemptAuthority;
  resultsFor: ResultsFor;
  backend: AttemptBackend;
  artifactReader: ArtifactReader;
  close?: () => Promise<void>;
}

export type AttemptDependenciesFactory = () => Promise<AttemptDependencies>;
