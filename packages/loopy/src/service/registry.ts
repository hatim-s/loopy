import type { z } from "zod";
import type {
  DefinitionSummary,
  Graph,
  PutLoopyBody,
  routes,
  SavedLoopy,
  SourceArtifact,
} from "../contract/index.js";
import type { Store } from "../core/index.js";

/** Artifact writes finish before a definition becomes visible to new runs. */
export interface ArtifactRegistry {
  workspace(): Promise<string>;
  listSummaries(): Promise<DefinitionSummary[]>;
  summary(slug: string): Promise<DefinitionSummary | null>;
  get(slug: string): Promise<SavedLoopy | null>;
  revisionGraph(revision: string): Promise<Graph>;
  revisionSource(slug: string, revision: string): Promise<SourceArtifact>;
  save(body: PutLoopyBody): Promise<void>;
}

export interface SecretOperations {
  list(): string[] | Promise<string[]>;
  set(name: string, value: string): void | Promise<void>;
  remove(name: string): void | Promise<void>;
}

export interface ServiceOptions {
  store: Store;
  registry: (workspace: string) => ArtifactRegistry;
  clock: { now(): number };
  canonicalWorkspace: (workspace: string) => string | Promise<string>;
  secrets: SecretOperations;
  generateTypes: (
    body: z.output<typeof routes.generateTypes.body>,
  ) => Promise<z.output<typeof routes.generateTypes.response>>;
}
