import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { definitionSummary, type PutLoopyBody, validateCompiled } from "../contract/index.js";
import { canonicalJson } from "../core/index.js";
import { type ArtifactRegistry, ArtifactValidationError, RegistryError } from "../service/index.js";
import { writeFileAtomically } from "./fs.js";
import type { Registry } from "./registry.js";
import { registrySync } from "./registry.js";
import { redactSourceArtifact } from "./source-view.js";

export const saveCompiled = Effect.fn(function* (registry: Registry, body: PutLoopyBody) {
  const { bundles, sourceArtifact: artifact } = yield* validateCompiled(body).pipe(
    Effect.catchTag("CompiledValidationError", (cause) =>
      Effect.fail(new ArtifactValidationError({ cause })),
    ),
    Effect.catchTag("CompiledHashError", (cause) =>
      Effect.fail(new RegistryError({ operation: "hash compiled artifacts", cause })),
    ),
  );

  const unchanged = yield* registry.unchanged(body);

  // An old revision cannot gain today's source, even when formatting left its graph hash unchanged.
  const historical =
    unchanged.ok ||
    (yield* registrySync("check historical graph", () =>
      existsSync(registry.graphPath(body.revision)),
    ));

  const sourceArtifact = historical
    ? ({
        version: 1,
        status: "unavailable",
        revision: body.revision,
        reason: "not_captured",
      } as const)
    : yield* redactSourceArtifact(registry.home, artifact).pipe(
        Effect.mapError((cause) => new RegistryError({ operation: "redact source", cause })),
      );

  if (unchanged.ok) {
    yield* registry.pinSource(body.graph.name, sourceArtifact);

    return unchanged.entry;
  }

  yield* registrySync("create bundle directory", () =>
    mkdirSync(join(registry.home, "bundles"), { recursive: true, mode: 0o700 }),
  );

  for (const value of bundles) {
    yield* registrySync("write bundle", () =>
      writeFileAtomically(registry.bundlePath(value.bundleHash), value.bytes, 0o600),
    );
  }

  yield* registrySync("create graph directory", () =>
    mkdirSync(join(registry.home, "graphs"), { recursive: true, mode: 0o700 }),
  );
  yield* registrySync("write graph", () =>
    writeFileAtomically(registry.graphPath(body.revision), canonicalJson(body.graph), 0o600),
  );

  return yield* registry.save({ ...body, sourceArtifact });
});

/** Capture one filesystem registry for a workspace lifetime. No open handles are retained. */
export const makeArtifactRegistry = (registry: Registry): ArtifactRegistry => ({
  workspace: () => Effect.succeed(registry.project),
  listSummaries: () =>
    registry.list().pipe(Effect.map((entries) => entries.map(definitionSummary))),
  get: (slug) =>
    registry.get(slug).pipe(Effect.catchTag("RegistryMissingError", () => Effect.succeed(null))),
  summary: (slug) =>
    registry.get(slug).pipe(
      Effect.map(definitionSummary),
      Effect.catchTag("RegistryMissingError", () => Effect.succeed(null)),
    ),
  revisionGraph: (revision) => registry.revisionGraph(revision),
  revisionSource: (slug, revision) => registry.revisionSource(slug, revision),
  save: (body) => saveCompiled(registry, body).pipe(Effect.asVoid),
});
