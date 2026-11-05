import { Effect } from "effect";
import { graphView, type PutLoopyBody } from "../contract/index.js";
import { ServiceError } from "./error.js";
import type { ArtifactRegistry, ServiceOptions } from "./registry.js";

export const requireDefinition = Effect.fn("definition.requireDefinition")(function* (
  registry: ArtifactRegistry,
  slug: string,
) {
  const saved = yield* registry.get(slug);

  if (saved === null) {
    return yield* Effect.fail(
      new ServiceError("not_found", `No saved loopy '${slug}'. Use loopy save <file.ts> first.`),
    );
  }

  return saved;
});

export function makeDefinitionOperations(options: ServiceOptions) {
  const putLoopy = Effect.fn("definition.putLoopy")(function* (slug: string, body: PutLoopyBody) {
    if (slug !== body.graph.name) {
      return yield* Effect.fail(
        new ServiceError("bad_request", "The URL name must match the graph name."),
      );
    }

    yield* (yield* options.registry(body.source.workspace)).save(body).pipe(
      Effect.catchTag("ArtifactValidationError", (error) =>
        Effect.fail(new ServiceError("bad_request", error.message)),
      ),
      Effect.catchTag("RegistryConflictError", (error) =>
        Effect.fail(new ServiceError("conflict", error.message)),
      ),
    );

    return graphView(body.graph);
  });

  const graph = Effect.fn("definition.graph")(function* (slug: string, workspace: string) {
    const saved = yield* requireDefinition(yield* options.registry(workspace), slug);

    return { revision: saved.revision, graph: graphView(saved.graph) };
  });

  return {
    putLoopy,
    graph,
    listSecrets: () => options.secrets.list(),
    putSecret: (name: string, value: string) =>
      options.secrets.set(name, value).pipe(Effect.as({ name, saved: true as const })),
    deleteSecret: (name: string) =>
      options.secrets.remove(name).pipe(Effect.as({ name, removed: true as const })),
    generateTypes: (body: Parameters<ServiceOptions["generateTypes"]>[0]) =>
      options.generateTypes(body),
  };
}

export type DefinitionOperations = ReturnType<typeof makeDefinitionOperations>;
