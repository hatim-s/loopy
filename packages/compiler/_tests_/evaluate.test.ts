import { expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { compiledBody } from "../../runtime/_tests_/fixtures/compiled";
import { onCleanup } from "../../runtime/_tests_/fixtures/test-scope";
import { evaluate as evaluateEffect } from "../src/evaluate";
import { compile, project } from "./fixtures/compile";

function evaluate(...args: Parameters<typeof evaluateEffect>) {
  return Effect.runPromise(evaluateEffect(...args));
}

test("subgraphs expand in each author module's directory", async () => {
  const { root, file } = await project(
    'import {loopy} from "loopy"; import {child} from "./child/graph.ts"; export default loopy("scoped", {input:{},run:()=>child()});',
  );

  await Bun.write(
    join(root, "child/graph.ts"),
    `import {code,subgraph} from "loopy"; export const child=subgraph("child",()=>code("value",{in:{},out:{kind:"value",type:"number"},module:"./value.ts"}));`,
  );
  await Bun.write(join(root, "child/value.ts"), "export default () => 1;");
  const result = await compile(file);

  if (!result.ok) {
    throw new Error(JSON.stringify(result.diagnostics));
  }

  expect(result.graph.nodes[0]).toMatchObject({
    kind: "code",
    module: { path: "child/value.ts" },
  });
});

for (const effect of ["network", "write"]) {
  test(`evaluation sandbox denies ${effect} even if AST validation is bypassed`, async () => {
    const { root, file } = await project("export default {};");
    const outside = `${root}-outside`;
    onCleanup(() => rm(outside, { force: true }));

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reachable"),
    });

    const graph = JSON.stringify((await compiledBody("isolated", file)).graph);

    const source =
      effect === "network"
        ? `await fetch(${JSON.stringify(server.url.toString())}); export default ${graph};`
        : `await Bun.write(${JSON.stringify(outside)}, "escaped"); export default ${graph};`;

    await writeFile(file, source);

    try {
      await expect(evaluate(file, [{ file, evaluated: source }])).rejects.toMatchObject({
        _tag: "AuthorDiagnostics",
        diagnostics: [{ code: "evaluation_failed" }],
      });
    } finally {
      await server.stop(true);
    }

    expect(await Bun.file(outside).exists()).toBe(false);
  });
}

test("evaluation has a hard ten second timeout", async () => {
  const { file } = await project("while(true){} export default {};");
  const source = await Bun.file(file).text();
  const started = performance.now();
  await expect(evaluate(file, [{ file, evaluated: source }])).rejects.toMatchObject({
    _tag: "AuthorDiagnostics",
    diagnostics: [{ code: "evaluation_failed", message: "Command timed out after 10000 ms." }],
  });
  expect(performance.now() - started).toBeLessThan(12_000);
}, 15_000);

for (const [name, source, message] of [
  ["invalid graph", "export default null;", "Expected object"],
  ["output overflow", 'export default "x".repeat(17_000_000);', "output exceeded"],
] as const) {
  test(`evaluator ${name} stays an author failure`, async () => {
    const { file } = await project(source);
    await expect(evaluate(file, [{ file, evaluated: source }])).rejects.toMatchObject({
      _tag: "AuthorDiagnostics",
      diagnostics: [{ code: "evaluation_failed", message: expect.stringContaining(message) }],
    });
  });
}
