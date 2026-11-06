import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Data, Effect } from "effect";
import { z } from "zod";
import { compile } from "../../packages/loopy/src/compiler";
import { decodeBoundary, putLoopyBodySchema, routes } from "../../packages/loopy/src/contract";
import { requireCurrentBaseline } from "./baseline";
import { PlaygroundClient } from "./client";
import { atomic, evidenceDirectory, profile, root, state } from "./config";
import { catalog, prepareRepository, repository } from "./repository";

export class PreparationError extends Data.TaggedError("PreparationError")<{
  message: string;
  cause?: unknown;
}> {}

const io = <A>(operation: string, run: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new PreparationError({ message: `Playground ${operation} failed.`, cause }),
  });

export function prepare() {
  return Effect.gen(function* () {
    const client = yield* io("prepare fixture", () => PlaygroundClient.open());
    const snapshot = yield* io("prepare fixture", () => prepareRepository());
    const revisions: { group: string; slug: string; revision: string; file: string }[] = [];

    for (const group of ["a", "b", "c"] as const) {
      for (const fixture of yield* io("prepare fixture", () => catalog(group))) {
        const file = resolve(repository, "fixtures", group, fixture.file);
        const compiled = yield* compile(file);

        if (!compiled.ok) {
          return yield* Effect.fail(
            new PreparationError({
              message: `Mock repo fixture ${fixture.slug} failed compilation: ${compiled.diagnostics.map((value) => value.code).join(",")}`,
            }),
          );
        }

        if (compiled.graph.name !== fixture.slug) {
          return yield* Effect.fail(
            new PreparationError({
              message: `Catalog slug ${fixture.slug} differs from compiled graph ${compiled.graph.name}.`,
            }),
          );
        }

        const body = decodeBoundary(putLoopyBodySchema)({
          graph: compiled.graph,
          revision: compiled.revision,
          sourceArtifact: compiled.sourceArtifact,
          bundles: compiled.bundles.map((bundle) => ({
            ...bundle,
            bytes: Buffer.from(bundle.bytes).toString("base64"),
          })),
          source: { path: file, workspace: "playground" },
          replace: true,
        });

        yield* io("prepare fixture", () =>
          client.json(routes.putLoopy.response, `/loopies/${fixture.slug}`, body, "PUT"),
        );
        revisions.push({ group, slug: fixture.slug, revision: compiled.revision, file });
      }
    }

    yield* io("prepare fixture", () => mkdir(evidenceDirectory, { recursive: true }));

    const evidence = {
      batch: client.settings.batch,
      at: new Date().toISOString(),
      repository,
      ...snapshot,
      sourceHash: (yield* io("prepare fixture", () =>
        Bun.file(resolve(repository, ".playground-source-sha256")).text(),
      )).trim(),
      revisions,
    };

    yield* io("prepare fixture", () =>
      atomic(resolve(evidenceDirectory, "playground-driver-source.json"), evidence),
    );
    yield* io("prepare fixture", () => atomic(resolve(state, "source-ready.json"), evidence));
    console.log(
      JSON.stringify({
        status: "source-ready",
        repository,
        commit: snapshot.commit,
        workflows: revisions.length,
      }),
    );
  });
}

interface ArmContext {
  root: string;
  state: string;
  evidenceDirectory: string;
  profile: typeof profile.name;
  batch: string;
}

export async function arm(baseline: string, context?: ArmContext) {
  const selected = context ?? {
    root,
    state,
    evidenceDirectory,
    profile: profile.name,
    batch: (await PlaygroundClient.open()).settings.batch,
  };

  const source = z
    .object({ batch: z.string(), revisions: z.array(z.unknown()).length(15) })
    .parse(await Bun.file(resolve(selected.state, "source-ready.json")).json());

  if (
    source.batch !== selected.batch ||
    !(await Bun.file(resolve(selected.root, baseline)).exists())
  ) {
    throw new Error(
      "Load requires the current 15-workflow source snapshot and a saved baseline receipt.",
    );
  }

  if (selected.profile) {
    await requireCurrentBaseline(
      resolve(selected.root, baseline),
      source.batch,
      selected.evidenceDirectory,
    );
  }

  for (const group of ["a", "b", "c"]) {
    const preflight = z
      .object({ status: z.literal("passed"), batch: z.string(), completed: z.literal(1) })
      .parse(
        await Bun.file(
          resolve(selected.evidenceDirectory, `playground-driver-preflight-${group}.json`),
        ).json(),
      );

    if (preflight.batch !== source.batch) {
      throw new Error("Preflight belongs to another batch.");
    }
  }

  await atomic(resolve(selected.state, "load-enabled.json"), {
    batch: source.batch,
    baseline: resolve(selected.root, baseline),
    enabledAt: new Date().toISOString(),
  });
  console.log("Load gate opened for the current batch. Group leads may invoke their own cohort.");
}
