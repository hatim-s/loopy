import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { encodeBoundary, putLoopyBodySchema } from "@loopy/contract";
import { revision } from "@loopy/core";
import { Registry } from "@loopy/runtime/local";
import { Effect } from "effect";
import { compiledBody } from "../../runtime/_tests_/fixtures/compiled";
import { serveHttp } from "../../runtime/_tests_/fixtures/http-server";
import { serviceFixture } from "../../runtime/_tests_/fixtures/server";
import { compileOrThrow } from "./fixtures/compile";

function artifactState(paths: string[]) {
  return paths.map((path) => {
    const { ino, mtimeMs, ctimeMs, size, mode } = statSync(path);

    return { ino, mtimeMs, ctimeMs, size, mode };
  });
}

test("compiled save route verifies artifacts, stores private bundles and returns only GraphView", async () => {
  const { f, service, store } = await serviceFixture("compiled-save");
  const source = join(f.cwd, "compiled.ts");
  const sdk = "loopy";
  await Bun.write(
    source,
    `import {loopy,code} from ${JSON.stringify(sdk)}; export default loopy("compiled-save", {input:{},run:()=>code("answer",{in:{},out:{kind:"value",type:"number"},module:"./answer.ts"})});`,
  );
  await Bun.write(
    join(f.cwd, "answer.ts"),
    'throw new Error("Must not execute while saving."); export default () => 42;',
  );
  const result = await compileOrThrow(source);

  const body = {
    ...(await compiledBody("compiled-save", source)),
    replace: true,
    graph: result.graph,
    revision: result.revision,
    bundles: result.bundles,
  };

  const { request } = serveHttp({ service, store, cwd: f.cwd });

  const put = (payload: typeof body) =>
    request("/loopies/compiled-save", {
      method: "PUT",
      body: JSON.stringify(encodeBoundary(putLoopyBodySchema)(payload)),
    });

  expect((await put({ ...body, revision: "0".repeat(64) })).status).toBe(400);
  expect((await put({ ...body, bundles: [] })).status).toBe(400);
  expect(
    (
      await put({
        ...body,
        bundles: body.bundles.map((bundle) => ({
          ...bundle,
          bytes: new TextEncoder().encode("changed"),
        })),
      })
    ).status,
  ).toBe(400);
  const response = await put(body);
  expect(response.status).toBe(200);
  const serialized = JSON.stringify(await response.json());
  expect(serialized).not.toMatch(/"(?:bytes|bundleHash|source|revision)":/);
  const registry = await Effect.runPromise(Registry.make(f.home, f.cwd));
  const saved = await Effect.runPromise(registry.get("compiled-save"));

  if (saved === null) {
    throw new Error("Expected the saved loopy.");
  }

  const paths = [
    join(registry.projectDirectory, "compiled-save.json"),
    registry.graphPath(saved.revision),
    ...saved.bundles.map((bundle) => registry.bundlePath(bundle.bundleHash)),
  ];

  const before = artifactState(paths);
  expect((await put(body)).status).toBe(200);
  expect(await Effect.runPromise(registry.get("compiled-save"))).toEqual(saved);
  expect(artifactState(paths)).toEqual(before);
  expect(
    (
      await put({
        ...body,
        bundles: body.bundles.map((bundle) => ({
          ...bundle,
          bytes: new TextEncoder().encode("forged"),
        })),
      })
    ).status,
  ).toBe(400);
  const globalGraph = { ...body.graph, meta: { ...body.graph.meta, scope: "global" as const } };

  const globalBody = {
    ...body,
    graph: globalGraph,
    revision: await revision(globalGraph),
    source: { ...body.source, path: `${source}-global` },
  };

  expect((await put(globalBody)).status).toBe(200);

  const globalPaths = [
    join(registry.globalDirectory, "compiled-save.json"),
    registry.graphPath(globalBody.revision),
    ...saved.bundles.map((bundle) => registry.bundlePath(bundle.bundleHash)),
  ];

  const globalBefore = artifactState(globalPaths);
  expect((await put(globalBody)).status).toBe(200);
  expect(artifactState(globalPaths)).toEqual(globalBefore);
  expect(await Effect.runPromise(registry.get("compiled-save"))).toEqual(saved);
  expect(saved.revision).toBe(result.revision);
  expect(saved.bundles).toEqual(
    result.bundles.map(({ nodeId, bundleHash }) => ({ nodeId, bundleHash })),
  );

  for (const bundle of result.bundles) {
    expect(statSync(registry.bundlePath(bundle.bundleHash)).mode & 0o777).toBe(0o600);
    expect([
      ...new Uint8Array(await Bun.file(registry.bundlePath(bundle.bundleHash)).arrayBuffer()),
    ]).toEqual([...bundle.bytes]);
  }
});

test("saving another revision retains the earlier graph and executable artifacts", async () => {
  const { f, service } = await serviceFixture("revisions");
  const source = join(f.cwd, "revision.ts");
  await Bun.write(
    source,
    `import {loopy,code} from "loopy"; export default loopy("revisions", {input:{},run:()=>code("value",{in:{},out:{kind:"value",type:"number"},module:"./value.ts"})});`,
  );
  const registry = await Effect.runPromise(Registry.make(f.home, f.cwd));
  const revisions: string[] = [];

  for (const value of [1, 2]) {
    await Bun.write(join(f.cwd, "value.ts"), `export default ()=>${value};`);
    const compiled = await compileOrThrow(source);

    await Effect.runPromise(
      service.putLoopy("revisions", {
        ...(await compiledBody("revisions", source)),
        replace: true,
        graph: compiled.graph,
        revision: compiled.revision,
        bundles: compiled.bundles,
      }),
    );
    revisions.push(compiled.revision);
  }

  expect(revisions[0]).not.toBe(revisions[1]);

  for (const revision of revisions) {
    const graph = await Bun.file(registry.graphPath(revision)).json();
    expect(graph.name).toBe("revisions");
    expect(statSync(registry.graphPath(revision)).mode & 0o777).toBe(0o600);
  }

  expect(revisions.at(-1)).toBe((await Effect.runPromise(registry.get("revisions")))?.revision);
});
