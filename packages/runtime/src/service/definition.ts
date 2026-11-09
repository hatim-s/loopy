import { graphView, type PutLoopyBody } from "@loopy/contract";
import type { SecretError } from "@loopy/core";
import { Effect } from "effect";
import { ServiceError } from "./error";
import type { ArtifactRegistry, ServiceOptions } from "./registry";

export const requireDefinition = Effect.fn("definition.requireDefinition")(function* (
  registry: Pick<ArtifactRegistry, "get">,
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

// An invalid name or value is the caller's mistake; storage failures stay internal.
const invalidSecret = (error: SecretError) =>
  Effect.fail(error.reason === "invalid" ? new ServiceError("bad_request") : error);

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
    listSecrets: () => options.secrets.list().pipe(Effect.catchTag("SecretError", invalidSecret)),
    putSecret: (name: string, value: string) =>
      options.secrets
        .set(name, value)
        .pipe(
          Effect.catchTag("SecretError", invalidSecret),
          Effect.as({ name, saved: true as const }),
        ),
    deleteSecret: (name: string) =>
      options.secrets
        .remove(name)
        .pipe(
          Effect.catchTag("SecretError", invalidSecret),
          Effect.as({ name, removed: true as const }),
        ),
    generateTypes: (body: Parameters<ServiceOptions["generateTypes"]>[0]) =>
      options.generateTypes(body),
  };
}

export type DefinitionOperations = ReturnType<typeof makeDefinitionOperations>;
