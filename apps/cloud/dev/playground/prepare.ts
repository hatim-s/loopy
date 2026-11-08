import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { compile } from "@loopy/compiler";
import { decodeBoundary, encodeBoundary, routes } from "@loopy/contract";
import { Effect, Schema } from "effect";
import { failure, io } from "../../../sandbox/src/operations";
import { requireCurrentBaseline } from "./baseline";
import { PlaygroundClient } from "./client";
import { evidence, profile, state } from "./config";
import { atomic } from "./files";
import { gatePath, gateSchema, groupSchema, groups, readSummary, summaryPath } from "./journal";
import { FIXTURES_PER_GROUP } from "./plan";
import type { PlaygroundProfile } from "./profile";
import { catalog, prepareRepository } from "./repository";

const WORKFLOWS = groups.length * FIXTURES_PER_GROUP;

const sourceReadySchema = Schema.Struct({
  batch: Schema.String,
  at: Schema.String,
  repository: Schema.String,
  commit: Schema.String,
  files: Schema.Int,
  sourceHash: Schema.String,
  revisions: Schema.Array(
    Schema.Struct({
      group: groupSchema,
      slug: Schema.String,
      revision: Schema.String,
      file: Schema.String,
    }),
  ).check(Schema.isBetweenLength(WORKFLOWS, WORKFLOWS)),
});

const sourceReadyPath = (directory: string) => resolve(directory, "source-ready.json");

export function prepare() {
  return Effect.gen(function* () {
    const operation = "prepare fixture";
    const client = yield* io(operation, () => PlaygroundClient.open());
    const snapshot = yield* io(operation, () => prepareRepository());
    const revisions: (typeof sourceReadySchema.Type)["revisions"][number][] = [];

    for (const group of groups) {
      for (const fixture of yield* io(operation, () => catalog(group))) {
        const file = resolve(profile.repository, "fixtures", group, fixture.file);
        const compiled = yield* compile(file);

        if (!compiled.ok) {
          return yield* Effect.fail(
            failure(
              operation,
              undefined,
              `Mock repo fixture ${fixture.slug} failed compilation: ${compiled.diagnostics.map((value) => value.code).join(",")}`,
            ),
          );
        }

        if (compiled.graph.name !== fixture.slug) {
          return yield* Effect.fail(
            failure(
              operation,
              undefined,
              `Catalog slug ${fixture.slug} differs from compiled graph ${compiled.graph.name}.`,
            ),
          );
        }

        yield* io(operation, () =>
          client.call(routes.putLoopy, {
            params: { slug: fixture.slug },
            body: {
              graph: compiled.graph,
              revision: compiled.revision,
              sourceArtifact: compiled.sourceArtifact,
              bundles: compiled.bundles,
              source: { path: file, workspace: "playground" },
              replace: true,
            },
          }),
        );
        revisions.push({ group, slug: fixture.slug, revision: compiled.revision, file });
      }
    }

    yield* io(operation, () => mkdir(evidence, { recursive: true }));

    const ready = encodeBoundary(sourceReadySchema)({
      batch: client.settings.batch,
      at: new Date().toISOString(),
      repository: profile.repository,
      ...snapshot,
      sourceHash: (yield* io(operation, () =>
        Bun.file(resolve(profile.repository, ".playground-source-sha256")).text(),
      )).trim(),
      revisions,
    });

    yield* io(operation, () => atomic(resolve(evidence, "playground-driver-source.json"), ready));
    yield* io(operation, () => atomic(sourceReadyPath(state), ready));
    console.log(
      JSON.stringify({
        status: "source-ready",
        repository: profile.repository,
        commit: snapshot.commit,
        workflows: revisions.length,
      }),
    );
  });
}

export async function arm(input: { profile: PlaygroundProfile; baseline: string; batch: string }) {
  const { profile: selected, batch } = input;
  const baseline = resolve(selected.root, input.baseline);

  const source = decodeBoundary(sourceReadySchema)(
    await Bun.file(sourceReadyPath(selected.state)).json(),
  );

  if (source.batch !== batch || !(await Bun.file(baseline).exists())) {
    throw new Error(
      `Load requires the current ${WORKFLOWS}-workflow source snapshot and a saved baseline receipt.`,
    );
  }

  if (selected.name === "architecture") {
    await requireCurrentBaseline(baseline, source.batch, selected.evidence);
  }

  for (const group of groups) {
    const preflight = await readSummary(summaryPath(selected.evidence, "preflight", group));

    if (preflight.status !== "passed" || preflight.completed !== 1) {
      throw new Error(`Preflight ${group} has not passed. Run it before opening the load gate.`);
    }

    if (preflight.batch !== source.batch) {
      throw new Error("Preflight belongs to another batch.");
    }
  }

  await atomic(
    gatePath(selected.state),
    encodeBoundary(gateSchema)({
      batch: source.batch,
      baseline,
      enabledAt: new Date().toISOString(),
    }),
  );
  console.log("Load gate opened for the current batch. Group leads may invoke their own cohort.");
}
