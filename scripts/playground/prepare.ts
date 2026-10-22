import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { compile } from "../../packages/loopy/src/compiler/index.js";
import { putLoopyBodySchema, routes } from "../../packages/loopy/src/contract/index.js";
import { PlaygroundClient } from "./client.js";
import { atomic, root, state } from "./config.js";
import { catalog, prepareRepository, repository } from "./repository.js";

export async function prepare() {
  const client = await PlaygroundClient.open();
  const snapshot = await prepareRepository();
  const revisions: { group: string; slug: string; revision: string; file: string }[] = [];

  for (const group of ["a", "b", "c"] as const) {
    for (const fixture of await catalog(group)) {
      const file = resolve(repository, "fixtures", group, fixture.file);
      const compiled = await compile(file);

      if (!compiled.ok) {
        throw new Error(
          `Mock repo fixture ${fixture.slug} failed compilation: ${compiled.diagnostics.map((value) => value.code).join(",")}`,
        );
      }

      if (compiled.graph.name !== fixture.slug) {
        throw new Error(
          `Catalog slug ${fixture.slug} differs from compiled graph ${compiled.graph.name}.`,
        );
      }

      const body = putLoopyBodySchema.parse({
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

      await client.json(routes.putLoopy.response, `/loopies/${fixture.slug}`, body, "PUT");
      revisions.push({ group, slug: fixture.slug, revision: compiled.revision, file });
    }
  }

  await mkdir(resolve(root, ".notes/cloud/evidence"), { recursive: true });

  const evidence = {
    batch: client.settings.batch,
    at: new Date().toISOString(),
    repository,
    ...snapshot,
    sourceHash: (await Bun.file(resolve(repository, ".playground-source-sha256")).text()).trim(),
    revisions,
  };

  await atomic(resolve(root, ".notes/cloud/evidence/playground-driver-source.json"), evidence);
  await atomic(resolve(state, "source-ready.json"), evidence);
  console.log(
    JSON.stringify({
      status: "source-ready",
      repository,
      commit: snapshot.commit,
      workflows: revisions.length,
    }),
  );
}

export async function arm(baseline: string) {
  const client = await PlaygroundClient.open();

  const source = z
    .object({ batch: z.string(), revisions: z.array(z.unknown()).length(15) })
    .parse(await Bun.file(resolve(state, "source-ready.json")).json());

  if (
    source.batch !== client.settings.batch ||
    !(await Bun.file(resolve(root, baseline)).exists())
  ) {
    throw new Error(
      "Load requires the current 15-workflow source snapshot and a saved baseline receipt.",
    );
  }

  for (const group of ["a", "b", "c"]) {
    const preflight = z
      .object({ status: z.literal("passed"), batch: z.string(), completed: z.literal(1) })
      .parse(
        await Bun.file(
          resolve(root, `.notes/cloud/evidence/playground-driver-preflight-${group}.json`),
        ).json(),
      );

    if (preflight.batch !== source.batch) {
      throw new Error("Preflight belongs to another batch.");
    }
  }

  await atomic(resolve(state, "load-enabled.json"), {
    batch: source.batch,
    baseline: resolve(root, baseline),
    enabledAt: new Date().toISOString(),
  });
  console.log("Load gate opened for the current batch. Group leads may invoke their own cohort.");
}
