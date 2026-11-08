import type {
  DashboardReader,
  DefinitionSummary,
  Graph,
  PutLoopyBody,
  routes,
  SavedLoopy,
  SourceArtifact,
} from "@loopy/contract";
import type { Store } from "@loopy/core";
import { errorMessage } from "@loopy/core";
import { Data, type Effect, type Schema } from "effect";
import type { ServiceError } from "./error";

export class RegistryError extends Data.TaggedError("RegistryError")<{
  operation: string;
  cause: unknown;
}> {
  override get message() {
    return `Could not ${this.operation}. ${errorMessage(this.cause)}`;
  }
}

export class RegistryConflictError extends Data.TaggedError("RegistryConflictError")<{
  slug: string;
  message: string;
}> {}

export class ArtifactValidationError extends Data.TaggedError("ArtifactValidationError")<{
  cause: unknown;
}> {
  override get message() {
    return `Compiled artifact validation failed. ${errorMessage(this.cause)}`;
  }
}

/** Artifact writes finish before a definition becomes visible to new runs. */
export interface ArtifactRegistry {
  workspace(): Effect.Effect<string, RegistryError>;
  listSummaries(): Effect.Effect<DefinitionSummary[], RegistryError>;
  summary(slug: string): Effect.Effect<DefinitionSummary | null, RegistryError>;
  get(slug: string): Effect.Effect<SavedLoopy | null, RegistryError>;
  revisionGraph(revision: string): Effect.Effect<Graph, RegistryError>;
  revisionSource(slug: string, revision: string): Effect.Effect<SourceArtifact, RegistryError>;
  save(
    body: PutLoopyBody,
  ): Effect.Effect<void, RegistryError | RegistryConflictError | ArtifactValidationError>;
}

export class SecretError extends Data.TaggedError("SecretError")<{
  operation: "read" | "get" | "validate" | "set" | "remove";
  reason: "invalid" | "missing" | "io";
  cause: unknown;
}> {}

export class WorkspaceError extends Data.TaggedError("WorkspaceError")<{ cause: unknown }> {}

export class GenerationError extends Data.TaggedError("GenerationError")<{ cause: unknown }> {}

export interface SecretOperations {
  list(): Effect.Effect<string[], SecretError | ServiceError>;
  set(name: string, value: string): Effect.Effect<void, SecretError | ServiceError>;
  remove(name: string): Effect.Effect<void, SecretError | ServiceError>;
}

export interface ServiceOptions {
  store: Store & DashboardReader;
  registry: (workspace: string) => Effect.Effect<ArtifactRegistry, RegistryError | ServiceError>;
  clock: { now(): number };
  canonicalWorkspace: (workspace: string) => Effect.Effect<string, WorkspaceError | ServiceError>;
  secrets: SecretOperations;
  generateTypes: (
    body: Schema.Schema.Type<typeof routes.generateTypes.body>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof routes.generateTypes.response>,
    GenerationError | ServiceError
  >;
}
